/// <reference types="@cloudflare/vitest-pool-workers" />
import { SELF, env } from "cloudflare:test";
import { issueAccessToken } from "../../src/auth/tokens.ts";

/** Authenticated JSON request against the real worker (SELF). */
export async function api(
  userId: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const token = await issueAccessToken({
    userId,
    secret: env.AUTH_SECRET,
    ttlSeconds: 900,
  });
  return SELF.fetch(`https://localhost${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
