/**
 * The dates a gig form is asking for, gathered into one list — or a
 * reason it cannot be.
 *
 * Both places that create gigs (GigEdit.tsx and DraftReview.tsx) show a
 * primary "Date & time" plus any number of "Also on" rows
 * (components/ExtraDatesField.tsx), and both hand what they hold to
 * this one function before `createGigBatch` (lib/gig-batch.ts) writes
 * anything. Pure on purpose: the rules below are decisions from the
 * design (docs/superpowers/specs/2026-09-18-gig-batches-design.md),
 * and a decision that lives in two screens is a decision that drifts.
 *
 * Inputs are `DateTimeField` strings ("YYYY-MM-DDTHH:mm" or ""), which
 * is what the forms hold; the output is epoch ms, which is what
 * `GigInput.dateTime` takes.
 */
import { localInputToMs } from "./datetime.ts";

export type GigDatesResult =
  | { ok: true; dateTimes: (number | null)[] }
  | { ok: false; message: string };

/** Stated once, so the screen that shows it and the test that expects
 *  it cannot disagree about the wording. */
export const DUPLICATE_DATE_MESSAGE = "Two of the dates are the same — remove one.";

/**
 * The rules, in the order they apply:
 *
 *   - Blank extra rows are ignored. "+ Add another date" appends an
 *     empty row, and a row someone opened and never filled is not a
 *     gig they meant to create.
 *   - No date anywhere → `[null]`: ONE undated gig, which is exactly
 *     what the form has always saved when the date was left empty. An
 *     empty list would mean "create nothing", which no button on the
 *     form says.
 *   - Primary blank, extras present → the extras are the dates. The
 *     primary field is not special beyond being first; someone who
 *     filled the rows and not the box still named their dates.
 *   - Two rows resolving to the same moment → refused, with a message.
 *     Two gigs at the same instant is a data-entry slip, and the form
 *     is the place to catch it — an undo across N records is not.
 *   - Order is preserved as entered, never sorted: the first gig made
 *     is the one in the primary box, which is the one the person is
 *     taken to when there is only one.
 */
export function collectGigDates(primary: string, extras: string[]): GigDatesResult {
  const entered = [primary, ...extras].filter((value) => value !== "");
  if (entered.length === 0) return { ok: true, dateTimes: [null] };

  const dateTimes: (number | null)[] = [];
  const seen = new Set<number>();
  for (const value of entered) {
    const ms = localInputToMs(value);
    // A non-empty string that does not parse is treated as no date at
    // all rather than refused: `DateTimeField` cannot produce one, and
    // silently making it undated matches what `localInputToMs` already
    // does for the primary field today.
    if (ms === null) {
      dateTimes.push(null);
      continue;
    }
    if (seen.has(ms)) return { ok: false, message: DUPLICATE_DATE_MESSAGE };
    seen.add(ms);
    dateTimes.push(ms);
  }
  return { ok: true, dateTimes };
}
