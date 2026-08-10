/**
 * When a gig occupies time.
 *
 * Two features answer this question and must answer it identically:
 * the calendar sync, which turns a gig into an event (docs/plan.md
 * §9), and the availability projection, which subtracts it from free
 * time (Phase 12). If they disagreed, an agency would be offered a
 * slot the user's own calendar shows as booked — which is precisely
 * the failure the availability page exists to prevent.
 */

/**
 * Used only when a gig has no duration of its own. Phase 9 added the
 * field; everything created before it, and anything the user leaves
 * blank, still needs an end.
 */
export const DEFAULT_GIG_DURATION_MS = 4 * 60 * 60 * 1000;

/**
 * The longest a gig can run, per the write schema (domain/schemas.ts
 * caps durationMinutes at 24 * 60).
 *
 * Queries use it as a lower bound when looking for gigs that overlap a
 * window: a gig starting before the window can still run into it, and
 * this is how far back it is worth looking.
 */
export const MAX_GIG_DURATION_MS = 24 * 60 * 60 * 1000;

/** Just enough of a gig to place it in time. Deliberately narrow —
 *  callers on the public path must not be handed a whole row. */
export interface TimedGig {
  dateTime: number | null;
  durationMinutes: number | null;
}

/** The half-open interval a gig occupies, or null if it has no date. */
export function gigOccupies(gig: TimedGig): { start: number; end: number } | null {
  if (gig.dateTime === null) return null;
  return {
    start: gig.dateTime,
    end:
      gig.dateTime +
      (gig.durationMinutes !== null
        ? gig.durationMinutes * 60 * 1000
        : DEFAULT_GIG_DURATION_MS),
  };
}
