/**
 * Presence reporting: POST /api/activity/visibility.
 *
 * The client watches the Page Visibility API and accumulates intervals
 * during which Gigsy was actually on screen, then posts them here in
 * batches. Intervals rather than raw foreground/background events,
 * for one reason above all: Gigsy is offline-first, and a user can
 * work for an hour with no connection. Events would have to be
 * buffered and replayed anyway, so the client buffers the thing we
 * actually want to know and sends it when it can.
 *
 * That makes the timestamps CLIENT timestamps, arriving late and from
 * a clock nobody controls. They are sanity-checked rather than
 * trusted — see `clampInterval` — and every row records how long after
 * the fact it arrived, so a reader can tell live reporting from a
 * delayed offline flush.
 */
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { Bindings } from "../env.ts";
import { requireAuth, type AuthVars } from "../middleware/auth.ts";
import { ActivityRecorder } from "../activity/recorder.ts";

/** One flush carries at most this many intervals. A client with more
 *  backlog than this sends the rest on the next flush. */
export const MAX_INTERVALS = 200;

/**
 * Longest interval that could plausibly be one stretch of screen time.
 *
 * A sanity ceiling on a clock we do not own, not a judgement about how
 * long someone may use the app: anything past a day is a broken clock
 * or a stuck timer, and recording it would poison every average it
 * lands in.
 */
export const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** How far ahead of the server a client clock may be before its
 *  timestamps stop meaning anything. */
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** Intervals shorter than this are flicks through a tab strip, not
 *  use. Dropped so they do not inflate the session count. */
const MIN_INTERVAL_MS = 1000;

const Visibility = z.object({
  intervals: z
    .array(
      z.object({
        /**
         * Client-generated, so a retry after a lost response stores
         * the interval once rather than twice. Constrained to a UUID
         * and namespaced below: the client is choosing a primary key,
         * and must not be able to name a row it does not own.
         */
        id: z.string().uuid(),
        startedAt: z.number().int().nonnegative(),
        endedAt: z.number().int().nonnegative(),
      }),
    )
    .max(MAX_INTERVALS),
});

/** Keeps a client-chosen id inside its own namespace, so it can never
 *  collide with a row the worker wrote. */
function visibilityRowId(clientId: string): string {
  return `vis-${clientId}`;
}

export interface CleanInterval {
  startedAt: number;
  durationMs: number;
}

/**
 * Accept an interval, or reject it with a reason.
 *
 * Exported for the tests, because the rules here are the whole of the
 * trust boundary: everything past this point is written to the
 * activity log as fact.
 */
export function clampInterval(
  raw: { startedAt: number; endedAt: number },
  now: number,
): CleanInterval | null {
  const durationMs = raw.endedAt - raw.startedAt;
  if (durationMs < MIN_INTERVAL_MS) return null;
  if (durationMs > MAX_INTERVAL_MS) return null;
  // A start in the future means the clock is wrong, and every figure
  // derived from it would be too.
  if (raw.startedAt > now + MAX_CLOCK_SKEW_MS) return null;
  // Older than the retention window is not wrong, just pointless — the
  // prune would drop it on the next cron run.
  if (raw.startedAt < now - 90 * 24 * 60 * 60 * 1000) return null;
  return { startedAt: raw.startedAt, durationMs };
}

export function makeActivityRouter() {
  return new Hono<{ Bindings: Bindings; Variables: AuthVars }>()
    .use("*", requireAuth)
    .post("/visibility", zValidator("json", Visibility), async (c) => {
      const { intervals } = c.req.valid("json");
      const userId = c.get("userId");
      const now = Date.now();
      const recorder = ActivityRecorder.for(c.env.DB);

      let accepted = 0;
      for (const raw of intervals) {
        const clean = clampInterval(raw, now);
        if (clean === null) continue;
        await recorder.record(
          {
            id: visibilityRowId(raw.id),
            userId,
            kind: "app.visible",
            durationMs: clean.durationMs,
            detail: {
              // How late this arrived. Near zero is live reporting; a
              // large value is an offline session flushed on
              // reconnect, which is the case this endpoint exists for.
              reportedAfterMs: Math.max(0, now - (clean.startedAt + clean.durationMs)),
            },
            ipCountry: c.req.header("cf-ipcountry") ?? null,
            userAgent: c.req.header("user-agent") ?? null,
          },
          clean.startedAt,
        );
        accepted++;
      }

      // The count comes back so the client can tell "stored" from
      // "silently discarded" — a clock-skew bug would otherwise look
      // exactly like working correctly.
      return c.json({ accepted, received: intervals.length });
    });
}
