/**
 * Google sign-in + session refresh (docs/plan.md §6).
 *
 * External I/O (Google JWKS fetch, auth-code exchange) is injected via
 * `AuthDeps` so the full flow is testable offline; index.ts mounts the
 * default (real) deps. Access tokens are short-lived JWTs; refresh
 * tokens are opaque, hashed at rest, and rotated on every use.
 */
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { Bindings } from "../env.ts";
import { issueAccessToken } from "../auth/tokens.ts";
import { encryptString } from "../auth/crypto.ts";
import {
  defaultJwksFetcher,
  exchangeAuthCode,
  verifyGoogleIdToken,
  type JwksFetcher,
} from "../auth/google.ts";
import { RefreshTokenStore } from "../auth/refresh-store.ts";
import { UsersRepo } from "../repos/users.ts";
import { log } from "../logger.ts";

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// GIS popup-mode code clients exchange with this pseudo redirect URI.
const REDIRECT_URI = "postmessage";

export interface AuthDeps {
  fetchJwks: JwksFetcher;
  exchangeCode: typeof exchangeAuthCode;
}

export const defaultAuthDeps: AuthDeps = {
  fetchJwks: defaultJwksFetcher,
  exchangeCode: exchangeAuthCode,
};

const GoogleLogin = z.object({
  idToken: z.string().min(1),
  // Present only when the consent flow granted Calendar scope.
  authCode: z.string().min(1).optional(),
});

const Refresh = z.object({ refreshToken: z.string().min(1) });

async function issueSession(
  env: Bindings,
  userId: string,
  now: number,
): Promise<{ accessToken: string; refreshToken: string }> {
  return {
    accessToken: await issueAccessToken({
      userId,
      secret: env.AUTH_SECRET,
      ttlSeconds: ACCESS_TOKEN_TTL_SECONDS,
    }),
    refreshToken: await RefreshTokenStore.for(env.DB).issue(
      userId,
      now,
      REFRESH_TOKEN_TTL_MS,
    ),
  };
}

export function makeAuthRouter(deps: AuthDeps = defaultAuthDeps) {
  return new Hono<{ Bindings: Bindings }>()
    .post("/google", zValidator("json", GoogleLogin), async (c) => {
      const { idToken, authCode } = c.req.valid("json");

      const claims = await verifyGoogleIdToken({
        idToken,
        clientId: c.env.GOOGLE_CLIENT_ID,
        fetchJwks: deps.fetchJwks,
      });
      if (claims === null) return c.json({ error: "unauthorized" }, 401);

      const now = Date.now();
      const usersRepo = UsersRepo.for(c.env.DB);
      const user = await usersRepo.upsertByEmail(claims.email, now);

      if (authCode !== undefined) {
        const exchanged = await deps.exchangeCode({
          code: authCode,
          clientId: c.env.GOOGLE_CLIENT_ID,
          clientSecret: c.env.GOOGLE_CLIENT_SECRET,
          redirectUri: REDIRECT_URI,
        });
        if (exchanged !== null) {
          await usersRepo.setGoogleRefreshTokenEnc(
            user.id,
            await encryptString(exchanged.refreshToken, c.env.REFRESH_TOKEN_ENC_KEY),
            now,
          );
        } else {
          // Login still succeeds — calendar sync just stays unarmed
          // until a future consent provides a working code.
          log.warn("google auth-code exchange failed", { userId: user.id });
        }
      }

      const session = await issueSession(c.env, user.id, now);
      return c.json({ ...session, user: { id: user.id, email: user.email } });
    })
    .post("/refresh", zValidator("json", Refresh), async (c) => {
      const { refreshToken } = c.req.valid("json");
      const now = Date.now();
      const userId = await RefreshTokenStore.for(c.env.DB).consume(
        refreshToken,
        now,
      );
      if (userId === null) return c.json({ error: "unauthorized" }, 401);
      return c.json(await issueSession(c.env, userId, now));
    });
}
