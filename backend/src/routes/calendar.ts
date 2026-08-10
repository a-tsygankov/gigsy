/**
 * Calendar connection + manual sync (docs/plan.md §9). External I/O
 * (code exchange, token mint, Calendar API) arrives via CalendarDeps
 * so the whole surface tests offline; index.ts mounts real deps.
 */
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { Bindings } from "../env.ts";
import { requireAuth, type AuthVars } from "../middleware/auth.ts";
import { UsersRepo } from "../repos/users.ts";
import { encryptString } from "../auth/crypto.ts";
import { resolveRefreshToken } from "../calendar/token.ts";
import { exchangeAuthCode } from "../auth/google.ts";
import {
  CalendarClient,
  mintAccessToken,
  type MintOptions,
} from "../calendar/google-calendar.ts";
import {
  syncUserGigs,
  type CalendarClientLike,
} from "../calendar/sync-service.ts";
import { log } from "../logger.ts";

export interface CalendarDeps {
  exchangeCode: typeof exchangeAuthCode;
  mintAccessToken: (options: MintOptions) => ReturnType<typeof mintAccessToken>;
  makeClient: (accessToken: string) => CalendarClientLike;
}

export const defaultCalendarDeps: CalendarDeps = {
  exchangeCode: exchangeAuthCode,
  mintAccessToken,
  makeClient: (accessToken) => new CalendarClient(accessToken),
};

const Connect = z.object({ authCode: z.string().min(1) });

export function makeCalendarRouter(deps: CalendarDeps = defaultCalendarDeps) {
  return new Hono<{ Bindings: Bindings; Variables: AuthVars }>()
    .use("*", requireAuth)
    .get("/status", async (c) => {
      const usersRepo = UsersRepo.for(c.env.DB);
      const user = await usersRepo.get(c.get("userId"));
      // Reading the token here is what makes a broken connection
      // self-heal: an unreadable one is cleared, so this reports
      // disconnected and the dashboard offers Connect again.
      const refreshToken =
        user === null
          ? null
          : await resolveRefreshToken(usersRepo, user, c.env.REFRESH_TOKEN_ENC_KEY);
      return c.json({
        connected: refreshToken !== null,
        lastSyncAt: user?.lastCalendarSyncAt ?? null,
      });
    })
    /** Explicit disconnect — the way back when a connection is wedged
     * or the user wants to re-grant against a different account. */
    .delete("/connection", async (c) => {
      await UsersRepo.for(c.env.DB).setGoogleRefreshTokenEnc(
        c.get("userId"),
        null,
        Date.now(),
      );
      return c.json({ connected: false });
    })
    .post("/connect", zValidator("json", Connect), async (c) => {
      const exchanged = await deps.exchangeCode({
        code: c.req.valid("json").authCode,
        clientId: c.env.GOOGLE_CLIENT_ID,
        clientSecret: c.env.GOOGLE_CLIENT_SECRET,
        redirectUri: "postmessage",
      });
      if (exchanged === null) {
        return c.json({ error: "authorization exchange failed" }, 400);
      }
      const usersRepo = UsersRepo.for(c.env.DB);
      await usersRepo.setGoogleRefreshTokenEnc(
        c.get("userId"),
        await encryptString(exchanged.refreshToken, c.env.REFRESH_TOKEN_ENC_KEY),
        Date.now(),
      );
      // Connecting means "put my gigs on this calendar", so the
      // watermark resets and the next run reconsiders everything.
      // Without this, a reconnect only picks up gigs touched since the
      // last successful run — so an existing schedule silently never
      // appears, which is exactly how a working sync looks broken.
      await usersRepo.setLastCalendarSyncAt(c.get("userId"), 0);
      return c.json({ connected: true });
    })
    .post("/sync-now", async (c) => {
      const userId = c.get("userId");
      const usersRepo = UsersRepo.for(c.env.DB);
      const user = await usersRepo.get(userId);
      if (user?.googleRefreshTokenEnc == null) {
        return c.json({ error: "calendar not connected" }, 409);
      }

      const refreshToken = await resolveRefreshToken(
        usersRepo,
        user,
        c.env.REFRESH_TOKEN_ENC_KEY,
      );
      if (refreshToken === null) {
        return c.json({ error: "stored token unreadable — reconnect" }, 409);
      }

      const minted = await deps.mintAccessToken({
        refreshToken,
        clientId: c.env.GOOGLE_CLIENT_ID,
        clientSecret: c.env.GOOGLE_CLIENT_SECRET,
      });
      if (minted === "revoked") {
        // Consent withdrawn on Google's side — disconnect cleanly.
        await usersRepo.setGoogleRefreshTokenEnc(userId, null, Date.now());
        log.warn("calendar token revoked — user disconnected", { userId });
        return c.json({ error: "calendar access revoked — reconnect" }, 409);
      }
      if (minted === null) {
        return c.json({ error: "could not reach Google — try again" }, 502);
      }

      const result = await syncUserGigs(
        c.env.DB,
        userId,
        deps.makeClient(minted.accessToken),
        Date.now(),
      );
      return c.json(result);
    });
}
