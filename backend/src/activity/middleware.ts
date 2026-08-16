/**
 * Records one activity event per API request.
 *
 * Two things keep this off the critical path:
 *
 * 1. It runs AFTER `next()`, so the response is already formed. The
 *    user waits for their gig to save, not for us to write down that
 *    they saved it.
 * 2. The insert is handed to `ctx.waitUntil`, so the response is
 *    returned while D1 is still being written. Where no execution
 *    context exists — `app.request()` in tests — it is awaited
 *    instead, which keeps tests deterministic without changing what
 *    production does.
 *
 * The userId is read after `next()` on purpose: `requireAuth` sets it
 * during the routers below, so before `next()` it is never there.
 */
import type { MiddlewareHandler } from "hono";
import type { Bindings } from "../env.ts";
import type { AuthVars } from "../middleware/auth.ts";
import { ActivityRecorder } from "./recorder.ts";

/**
 * Paths that generate no event.
 *
 * The same two the request log skips, for the same reason: the health
 * probe is noise, and the debug console polling for logs must not
 * generate the activity it is displaying. `/api/version` joins them —
 * the app polls it to notice deploys.
 */
function isIgnored(path: string): boolean {
  return (
    path === "/api/health" ||
    path === "/api/version" ||
    path.startsWith("/api/debug")
  );
}

export function recordActivity(): MiddlewareHandler<{
  Bindings: Bindings;
  Variables: AuthVars;
}> {
  return async (c, next) => {
    const start = Date.now();
    await next();

    const path = new URL(c.req.url).pathname;
    if (isIgnored(path)) return;

    const finished = Date.now();
    // Typed as string by AuthVars, but genuinely absent on the routes
    // that never mount requireAuth.
    const userId = (c.get("userId") as string | undefined) ?? null;

    const write = ActivityRecorder.for(c.env.DB).record(
      {
        userId,
        kind: "api.request",
        method: c.req.method,
        path,
        status: c.res.status,
        durationMs: finished - start,
        ipCountry: c.req.header("cf-ipcountry") ?? null,
        userAgent: c.req.header("user-agent") ?? null,
      },
      finished,
    );

    try {
      c.executionCtx.waitUntil(write);
    } catch {
      // No ExecutionContext (tests). Await rather than drop it — an
      // unawaited promise here would make assertions race the insert.
      await write;
    }
  };
}
