/**
 * JWT gate for user-scoped routes. Extracts the Bearer token, verifies
 * it, and exposes `userId` on the context — downstream handlers and
 * repos take the user id ONLY from here, never from the request body
 * (the entire multi-tenancy boundary, docs/plan.md §4).
 */
import type { MiddlewareHandler } from "hono";
import type { Bindings } from "../env.ts";
import { verifyAccessToken } from "../auth/tokens.ts";

export type AuthVars = { userId: string };

export const requireAuth: MiddlewareHandler<{
  Bindings: Bindings;
  Variables: AuthVars;
}> = async (c, next) => {
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  if (token === null) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const claims = await verifyAccessToken({ token, secret: c.env.AUTH_SECRET });
  if (claims === null) {
    return c.json({ error: "unauthorized" }, 401);
  }
  c.set("userId", claims.userId);
  await next();
};
