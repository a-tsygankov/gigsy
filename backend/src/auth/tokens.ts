/**
 * Worker-issued access tokens (docs/plan.md §6). HS256 short-lived
 * JWTs whose `sub` is the user id — the single source of user
 * identity for every scoped query. Verify-only consumers live in
 * middleware/auth.ts; Phase 2's Google flow becomes the real issuer.
 */
import { sign, verify } from "hono/jwt";

export interface IssueOptions {
  userId: string;
  secret: string;
  ttlSeconds: number;
  /** Injectable for tests (seconds since epoch). Default: now. */
  nowSeconds?: number;
}

export async function issueAccessToken(options: IssueOptions): Promise<string> {
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  return sign(
    { sub: options.userId, iat: now, exp: now + options.ttlSeconds },
    options.secret,
    "HS256",
  );
}

export interface VerifyOptions {
  token: string;
  secret: string;
}

export interface AccessClaims {
  userId: string;
}

/** Returns the claims for a valid token, null for anything else —
 * callers never see why (uniform 401s leak nothing). */
export async function verifyAccessToken(
  options: VerifyOptions,
): Promise<AccessClaims | null> {
  try {
    // The alg must be pinned explicitly — this also rules out
    // alg-confusion tokens (e.g. "none") by construction.
    const payload = await verify(options.token, options.secret, "HS256");
    const sub = payload["sub"];
    if (typeof sub !== "string" || sub.length === 0) return null;
    return { userId: sub };
  } catch {
    return null;
  }
}
