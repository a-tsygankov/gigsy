/**
 * The public availability endpoint (Phase 12, Task 2).
 *
 * The only unauthenticated, user-scoped route in the app. Everything
 * here follows from that:
 *
 * - The token is the whole access control, so it is resolved against
 *   hashes and every failure — unknown, revoked, expired — answers
 *   404. A 401 or a 403 would confirm that a link once existed.
 * - `X-Robots-Tag: noindex` and `Cache-Control: no-store` on every
 *   response, including the failures. A shared link is not a published
 *   one, and a schedule is not something to leave in a shared cache.
 * - The body is whatever buildPublicAvailability returns and nothing
 *   assembled here. This handler deliberately has no access to a gig,
 *   a client or an amount, so it cannot leak one.
 */
import { Hono } from "hono";
import type { Bindings } from "../env.ts";
import { AvailabilityTokenStore } from "../repos/availability-tokens.ts";
import { buildPublicAvailability } from "../services/availability.ts";
import { fixedWindowLimiter, type RateLimiter } from "../lib/rate-limit.ts";

/**
 * Generous for a page a person opens, tight for a machine reading it
 * on a loop. A phone loading the page costs one request.
 */
const DEFAULT_LIMIT = 120;
const DEFAULT_WINDOW_MS = 60 * 1000;

export function makeAvailabilityRouter(
  limiter: RateLimiter = fixedWindowLimiter({
    limit: DEFAULT_LIMIT,
    windowMs: DEFAULT_WINDOW_MS,
  }),
) {
  return new Hono<{ Bindings: Bindings }>()
    .use("*", async (c, next) => {
      await next();
      // On every path out of here, including 404 and 429.
      c.header("X-Robots-Tag", "noindex, nofollow");
      c.header("Cache-Control", "no-store");
    })
    .get("/:token", async (c) => {
      const now = Date.now();

      // Per-caller, so one scraper cannot spend everyone else's budget.
      // Absent in tests and in any request that did not come through
      // Cloudflare; those share a bucket, which is the safe direction.
      const caller = c.req.header("CF-Connecting-IP") ?? "unknown";
      const decision = limiter.check(caller, now);
      if (!decision.allowed) {
        return c.json({ error: "rate_limited" }, 429, {
          "Retry-After": String(decision.retryAfterSeconds),
        });
      }

      const userId = await AvailabilityTokenStore.for(c.env.DB).resolve(
        c.req.param("token"),
        now,
      );
      if (userId === null) {
        return c.json({ error: "not_found" }, 404);
      }

      return c.json(await buildPublicAvailability(c.env.DB, userId, now));
    });
}
