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
  createCalendar,
  mintAccessToken,
  queryFreeBusy,
  type MintOptions,
} from "../calendar/google-calendar.ts";
import { GigsRepo } from "../repos/gigs.ts";
import {
  syncUserGigs,
  type CalendarClientLike,
} from "../calendar/sync-service.ts";
import { log } from "../logger.ts";

export interface CalendarDeps {
  exchangeCode: typeof exchangeAuthCode;
  mintAccessToken: (options: MintOptions) => ReturnType<typeof mintAccessToken>;
  /** Bound to a calendar id, because Phase 11 lets that be a choice. */
  makeClient: (accessToken: string, calendarId: string) => CalendarClientLike;
  createCalendar: typeof createCalendar;
  /** Phase 12: used only to probe whether the grant covers reading. */
  queryFreeBusy: typeof queryFreeBusy;
}

export const defaultCalendarDeps: CalendarDeps = {
  exchangeCode: exchangeAuthCode,
  mintAccessToken,
  makeClient: (accessToken, calendarId) =>
    new CalendarClient(accessToken, undefined, calendarId),
  createCalendar,
  queryFreeBusy,
};

/** Long enough for Google to answer meaningfully, short enough that
 *  this is plainly a permission check and not a sync. */
const FREEBUSY_PROBE_MS = 60 * 60 * 1000;

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
    /**
     * Can we actually read this user's busy time? (Phase 12, Task 3)
     *
     * The availability page is only truthful if it knows about the
     * dentist and the school run, which needs `calendar.readonly` on
     * top of the `calendar.events` that connecting asks for. Every
     * grant made before Phase 12 is therefore too narrow, and a user
     * would have no way to discover that except by sharing a link built
     * on a wrong assumption.
     *
     * So: a probe, and every answer is a 200 with a reason. "Your grant
     * is too narrow" is something the UI acts on by asking for consent
     * again; "Google is down" is something it must NOT respond to that
     * way, or the user gets an unexplained popup they will decline.
     * Keeping those apart is the entire point of this endpoint.
     *
     * The hour of freebusy it reads is used to decide readable/not and
     * discarded — it is never returned, logged, or stored.
     */
    .get("/freebusy-check", async (c) => {
      const userId = c.get("userId");
      const usersRepo = UsersRepo.for(c.env.DB);
      const user = await usersRepo.get(userId);
      if (user?.googleRefreshTokenEnc == null) {
        return c.json({ readable: false, reason: "not-connected" } as const);
      }

      const refreshToken = await resolveRefreshToken(
        usersRepo,
        user,
        c.env.REFRESH_TOKEN_ENC_KEY,
      );
      if (refreshToken === null) {
        return c.json({ readable: false, reason: "not-connected" } as const);
      }

      const minted = await deps.mintAccessToken({
        refreshToken,
        clientId: c.env.GOOGLE_CLIENT_ID,
        clientSecret: c.env.GOOGLE_CLIENT_SECRET,
      });
      if (minted === "revoked") {
        // Unlike the public availability path, this request has the
        // user behind it, so healing here is safe and useful.
        await usersRepo.setGoogleRefreshTokenEnc(userId, null, Date.now());
        return c.json({ readable: false, reason: "not-connected" } as const);
      }
      if (minted === null) {
        return c.json({ readable: false, reason: "unavailable" } as const);
      }

      const now = Date.now();
      const probe = await deps.queryFreeBusy({
        accessToken: minted.accessToken,
        timeMinMs: now,
        timeMaxMs: now + FREEBUSY_PROBE_MS,
        calendarIds: ["primary"],
      });
      if (probe === "insufficient-scope") {
        return c.json({ readable: false, reason: "insufficient-scope" } as const);
      }
      if (probe === null) {
        return c.json({ readable: false, reason: "unavailable" } as const);
      }
      return c.json({ readable: true } as const);
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

      const settings = await usersRepo.getSettings(userId);
      const result = await syncUserGigs(
        c.env.DB,
        userId,
        deps.makeClient(minted.accessToken, settings.calendarTargetId),
        Date.now(),
      );
      // Always logged, including a run that did nothing: a manual sync
      // is someone asking "what happened?", and a 200 with no record of
      // the counts is the reason that question was unanswerable from
      // the hidden console.
      log.info("calendar sync-now", { userId, ...result });
      return c.json(result);
    })
    /**
     * Force a full reconciliation. Clearing the watermark makes the next
     * run reconsider every gig rather than only those touched since the
     * last one — the repair tool for "my calendar looks wrong".
     *
     * It does not sync; it makes the next sync exhaustive. Keeping those
     * separate means this stays instant and cannot half-fail.
     */
    .post("/resync", async (c) => {
      const userId = c.get("userId");
      await UsersRepo.for(c.env.DB).setLastCalendarSyncAt(userId, 0);
      log.info("calendar resync requested", { userId });
      return c.json({ queued: true });
    })
    /**
     * Create a dedicated "Gigsy" calendar and move future events to it.
     *
     * Events already on the previous calendar are deleted here, inline,
     * rather than queued: the cleanup queue has no column for *which*
     * calendar an orphan lives on, and a user-initiated switch can
     * report its own outcome — unlike the cron, which has to be
     * resumable. Anything Google refuses is counted and reported rather
     * than silently left behind.
     */
    .post("/dedicated", async (c) => {
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
        await usersRepo.setGoogleRefreshTokenEnc(userId, null, Date.now());
        return c.json({ error: "calendar access revoked — reconnect" }, 409);
      }
      if (minted === null) {
        return c.json({ error: "could not reach Google — try again" }, 502);
      }

      const created = await deps.createCalendar(minted.accessToken, "Gigsy");
      if (created === "insufficient-scope") {
        // Connecting only asks for calendar.events; making a calendar
        // needs the broader scope. Its own code, so the UI can re-prompt
        // for consent rather than say "something went wrong".
        return c.json({ error: "reconnect-required", scope: "calendar" }, 409);
      }
      if (created === null) {
        return c.json({ error: "could not create the calendar" }, 502);
      }

      const settings = await usersRepo.getSettings(userId);
      const previousId = settings.calendarTargetId;
      const gigsRepo = GigsRepo.for(c.env.DB);

      // Remove the old events from the calendar they actually live on.
      let removed = 0;
      let failed = 0;
      const previous = deps.makeClient(minted.accessToken, previousId);
      for (const gig of await gigsRepo.listWithCalendarEvent(userId)) {
        if (await previous.deleteEvent(gig.calendarEventId)) removed++;
        else failed++;
      }

      await gigsRepo.clearAllCalendarEventIds(userId);
      await usersRepo.updateSettings(
        userId,
        { calendarTargetId: created },
        Date.now(),
      );
      // Everything has to be re-created on the new calendar.
      await usersRepo.setLastCalendarSyncAt(userId, 0);

      log.info("calendar switched to dedicated", {
        userId,
        calendarId: created,
        removed,
        failed,
      });
      return c.json({ calendarId: created, removed, failed });
    });
}
