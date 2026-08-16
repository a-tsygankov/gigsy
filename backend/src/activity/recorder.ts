/**
 * Writes activity events, and is the only thing that does.
 *
 * The governing rule: **recording an event must never fail a request.**
 * This is observability, not a feature — if the insert fails, the user
 * gets their gig saved anyway and the worker log carries the
 * disappointment. Every method here swallows its own errors for that
 * reason, which is the opposite of what a repo should normally do.
 */
import { lt } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { activityEvents, type ActivityKind } from "../db/schema.ts";
import { log } from "../logger.ts";

export interface ActivityEventInput {
  /** Null before we know who is asking (a refused sign-in). */
  userId: string | null;
  kind: ActivityKind;
  method?: string;
  path?: string;
  status?: number;
  durationMs?: number;
  entityTable?: string;
  entityId?: string;
  /** Kept small: this is the only unbounded column on a table that
   *  gets a row per request. */
  detail?: Record<string, unknown>;
  ipCountry?: string | null;
  userAgent?: string | null;
}

/** Long user-agent strings are a browser's problem, not a reason for
 *  this table to grow without bound. */
const MAX_USER_AGENT = 200;

/**
 * Whether this isolate has already complained about a failed insert.
 *
 * A line per failure would be a line per REQUEST, and those land in the
 * same 200-entry ring buffer the debug console reads — so the one
 * condition worth diagnosing would flush every request log that could
 * explain it. Complain once, then stay quiet; the failure is systemic
 * by nature, and the second thousand lines say nothing the first did
 * not. Per-isolate, like the buffer itself.
 */
let failureReported = false;

function reportOnce(kind: string, error: unknown): void {
  if (failureReported) return;
  failureReported = true;
  log.warn("activity events are not being recorded", {
    kind,
    error: error instanceof Error ? error.message : String(error),
    note: "further failures in this isolate are silent",
  });
}

export class ActivityRecorder {
  constructor(private readonly db: DrizzleD1Database) {}

  static for(d1: D1Database): ActivityRecorder {
    return new ActivityRecorder(drizzle(d1));
  }

  /**
   * Append one event. Never throws.
   *
   * `now` is injected rather than read here so a caller that already
   * measured the request can stamp the event with the same clock it
   * used for the duration.
   */
  async record(event: ActivityEventInput, now: number): Promise<void> {
    try {
      await this.db
        .insert(activityEvents)
        .values({
          id: crypto.randomUUID(),
          userId: event.userId,
          ts: now,
          kind: event.kind,
          method: event.method ?? null,
          path: event.path ?? null,
          status: event.status ?? null,
          durationMs: event.durationMs ?? null,
          entityTable: event.entityTable ?? null,
          entityId: event.entityId ?? null,
          detailJson:
            event.detail === undefined ? null : JSON.stringify(event.detail),
          ipCountry: event.ipCountry ?? null,
          userAgent: event.userAgent?.slice(0, MAX_USER_AGENT) ?? null,
        })
        .run();
    } catch (error) {
      // Deliberately swallowed. A failure to observe must not become a
      // failure to serve.
      reportOnce(event.kind, error);
    }
  }

  /**
   * Drop events older than `before`. Returns how many went, or null if
   * the delete failed — the prune is best-effort like everything else
   * here, and a full table is better than a failed cron run.
   */
  async pruneOlderThan(before: number): Promise<number | null> {
    try {
      const deleted = await this.db
        .delete(activityEvents)
        .where(lt(activityEvents.ts, before))
        .returning({ id: activityEvents.id });
      return deleted.length;
    } catch (error) {
      // The prune runs 96 times a day, so this is rate-limited by the
      // same latch for the same reason.
      reportOnce("prune", error);
      return null;
    }
  }
}
