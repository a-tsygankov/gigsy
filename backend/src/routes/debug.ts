import { Hono } from "hono";
import type { Bindings } from "../env.ts";
import { logBuffer } from "../logger.ts";

const DEFAULT_LIMIT = 100;

/**
 * Debug endpoints for the webapp's hidden console.
 *
 * TODO(Phase 2): mount behind the JWT middleware once auth lands —
 * request logs are low-sensitivity but still not for anonymous eyes
 * in production.
 */
export const debugRouter = new Hono<{ Bindings: Bindings }>()
  // GET /api/debug/logs?limit=N — recent worker log lines, oldest →
  // newest, from the per-isolate ring buffer (best-effort history).
  .get("/logs", (c) => {
    const raw = Number(c.req.query("limit") ?? DEFAULT_LIMIT);
    const limit =
      Number.isInteger(raw) && raw > 0 ? Math.min(raw, DEFAULT_LIMIT) : DEFAULT_LIMIT;
    const entries = logBuffer.toArray().slice(-limit);
    return c.json({ entries });
  });
