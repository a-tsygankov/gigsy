/**
 * Retention for activity_events.
 *
 * This table gains a row per request and nothing ever updates it, so
 * without a prune it is the one part of the schema that grows without
 * bound. Ninety days is chosen to be longer than any question worth
 * asking of it — "when did the CI user last run" is a matter of days —
 * and short enough that the table stays small.
 *
 * Runs on the existing 15-minute cron rather than a schedule of its
 * own: deleting a quarter-hour late costs nothing, and a second
 * trigger would.
 */
import type { Bindings } from "../env.ts";
import { ActivityRecorder } from "./recorder.ts";
import { log } from "../logger.ts";

export const RETENTION_DAYS = 90;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

/** Returns how many rows went, or null when the delete failed. */
export async function runActivityPrune(
  env: Bindings,
  now: number = Date.now(),
): Promise<number | null> {
  const deleted = await ActivityRecorder.for(env.DB).pruneOlderThan(
    now - RETENTION_MS,
  );
  // Only worth a line when it did something — this runs 96 times a day
  // and will usually find nothing.
  if (deleted !== null && deleted > 0) {
    log.info("activity events pruned", { deleted, retentionDays: RETENTION_DAYS });
  }
  return deleted;
}
