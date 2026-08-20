/**
 * Whether a work log is one the server will accept.
 *
 * MIRRORS backend/src/domain/schemas.ts — the `breakMinutes` field rule
 * (`z.number().int().min(0).max(24 * 60).nullish()`) and the three
 * cross-field rules in `GigInput`'s superRefine. It lives here, beside
 * gig-pay.ts, because this repo already keeps its mirrored domain logic
 * in lib/ rather than inside a screen, and because a rule stated in a
 * component is a rule the next screen re-invents.
 *
 * Why mirror at all, when the server checks anyway: a rejected write is
 * not a visible error here. `putGig` succeeds locally and queues the op,
 * and when the server 400s it `sync-engine.ts` deletes the op with only
 * an `appLog.warn` — the edit is gone, with nothing on screen having
 * said so. Catching it against the field is the only place the person
 * who typed it can still fix it.
 *
 * Unmirrored on purpose: `workStartedAt`/`workEndedAt` are epoch-ms
 * integers on the wire, and every caller here gets them from
 * `localInputToMs`, which cannot produce a fraction.
 */

/** The schema's ceiling: a break longer than a day is a typo, not a
 *  break. Same figure as `max(24 * 60)` in domain/schemas.ts. */
export const MAX_BREAK_MINUTES = 24 * 60;

/**
 * The fault in a work log, or null when there is none.
 *
 * `breakMinutes` is checked BEFORE the cross-field rules, and that
 * order matters: a fractional or absurd break with no end stamp passes
 * every cross-field rule (they all need both ends), so without the
 * field rule first it commits, syncs, 400s and vanishes.
 */
export function workLogProblem(
  startMs: number | null,
  endMs: number | null,
  breakMinutes: number | null,
): string | null {
  if (breakMinutes !== null) {
    if (!Number.isFinite(breakMinutes) || !Number.isInteger(breakMinutes)) {
      return "Breaks are counted in whole minutes.";
    }
    if (breakMinutes < 0) return "A break can't be negative.";
    if (breakMinutes > MAX_BREAK_MINUTES) {
      return "That break is longer than a day — check the number.";
    }
  }
  if (endMs !== null && startMs === null) return "Work can't end without a start time.";
  if (startMs !== null && endMs !== null) {
    if (endMs <= startMs) return "Finished must be after Started.";
    if (breakMinutes !== null && breakMinutes * 60_000 >= endMs - startMs) {
      return "The break can't fill the whole shift.";
    }
  }
  return null;
}
