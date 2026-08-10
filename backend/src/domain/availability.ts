/**
 * Free-time projection (docs/…/phase12-availability.md, Task 1).
 *
 * Pure: takes busy blocks and preferences, returns free ranges. No I/O,
 * no knowledge of where the blocks came from — gigs today, Google's
 * freebusy later, both eventually. That seam is the point: which
 * sources feed it is still an open decision, and this module does not
 * need the answer.
 *
 * The privacy rule the whole phase defers to lives one layer up, but it
 * shapes this signature: the function returns FREE ranges, never busy
 * ones, so the route has nothing sensitive to accidentally serialise.
 */

/** A half-open interval [start, end) in epoch ms. */
export interface Range {
  start: number;
  end: number;
}

/**
 * Local working hours for one weekday, in minutes from local midnight.
 * `null` means a day off — not "0 to 0", which reads as a bug.
 */
export interface WorkingDay {
  startMinute: number;
  endMinute: number;
}

/** Index 0 = Sunday, matching Date#getDay and Intl's own ordering. */
export type WorkingWeek = readonly (WorkingDay | null)[];

export interface AvailabilityOptions {
  /** Now, so the past is never offered. */
  now: number;
  /** How far ahead to look. Bounded deliberately: an infinite calendar
   *  invites scraping and answers a question nobody asked. */
  horizonMs: number;
  workingWeek: WorkingWeek;
  /**
   * Local wall-clock for an instant, and the day's midnight.
   *
   * Injected rather than computed here because correct IANA handling —
   * DST especially — is its own problem with its own tests, and the
   * merge/mask/clamp rules below should not be hostage to it.
   */
  localDayAt: (ms: number) => { dayOfWeek: number; midnightMs: number };
  /** Gaps shorter than this are not availability. A 20-minute hole
   *  between two gigs is not something to offer an agency. */
  minSlotMs: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/**
 * Merge overlapping and touching ranges into the fewest that cover the
 * same time.
 *
 * Touching counts: [9,10) and [10,11) are one block from 9 to 11, and
 * leaving them separate would invent a zero-length gap between them.
 */
export function mergeRanges(ranges: readonly Range[]): Range[] {
  const sorted = [...ranges]
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start);

  const merged: Range[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/** The parts of `span` not covered by `busy`. */
export function subtractRanges(span: Range, busy: readonly Range[]): Range[] {
  const free: Range[] = [];
  let cursor = span.start;

  for (const block of mergeRanges(busy)) {
    if (block.end <= span.start || block.start >= span.end) continue;
    if (block.start > cursor) free.push({ start: cursor, end: block.start });
    cursor = Math.max(cursor, block.end);
  }
  if (cursor < span.end) free.push({ start: cursor, end: span.end });

  return free;
}

/**
 * The working windows between two instants, one per day that has hours.
 *
 * Built by walking days rather than by arithmetic on offsets, so a day
 * that is 23 or 25 hours long across a DST change still produces the
 * window its local clock says it should.
 */
export function workingWindows(
  from: number,
  to: number,
  options: Pick<AvailabilityOptions, "workingWeek" | "localDayAt">,
): Range[] {
  const windows: Range[] = [];
  // Start from the local midnight containing `from`; the first day's
  // window may have already begun.
  let { midnightMs } = options.localDayAt(from);

  // Guard against a localDayAt that fails to advance, which would spin
  // forever on a bad implementation rather than failing a test.
  let guard = 0;
  while (midnightMs < to && guard++ < 400) {
    const { dayOfWeek } = options.localDayAt(midnightMs);
    const hours = options.workingWeek[dayOfWeek] ?? null;
    if (hours !== null) {
      windows.push({
        start: midnightMs + hours.startMinute * MINUTE_MS,
        end: midnightMs + hours.endMinute * MINUTE_MS,
      });
    }
    const next = options.localDayAt(midnightMs + DAY_MS + DAY_MS / 2);
    // Re-derive rather than adding 24h, so DST days land correctly.
    midnightMs = next.midnightMs > midnightMs ? next.midnightMs : midnightMs + DAY_MS;
  }

  return windows;
}

/**
 * Free slots a client could be offered.
 *
 * Order matters and is the whole algorithm: clamp to [now, horizon],
 * mask to working hours, subtract what is busy, then drop anything too
 * short to be worth offering.
 */
export function availableSlots(
  busy: readonly Range[],
  options: AvailabilityOptions,
): Range[] {
  const span: Range = { start: options.now, end: options.now + options.horizonMs };
  if (span.end <= span.start) return [];

  const merged = mergeRanges(busy);

  return workingWindows(span.start, span.end, options)
    .map((window) => ({
      start: Math.max(window.start, span.start),
      end: Math.min(window.end, span.end),
    }))
    .filter((window) => window.end > window.start)
    .flatMap((window) => subtractRanges(window, merged))
    .filter((slot) => slot.end - slot.start >= options.minSlotMs);
}
