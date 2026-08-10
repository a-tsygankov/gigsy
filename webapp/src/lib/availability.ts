/**
 * Presenting someone else's free time (Phase 12, Task 4).
 *
 * One rule shapes all of this: the page speaks in the OWNER's
 * timezone. An agency in New York reading a London freelancer's page
 * must see London hours — otherwise it books a 09:00 that is really
 * 04:00, which is the confident wrongness this whole phase exists to
 * prevent.
 *
 * Locale is the reader's, because "9:00 AM" versus "09:00" is a
 * question of how they read a clock, not of which clock it is. So
 * every formatter here takes the zone from the payload and the locale
 * from the browser.
 */
import type { PublicAvailability, Slot } from "./availability-api.ts";

/** Formatters are not cheap and a month of slots makes many calls. */
const cache = new Map<string, Intl.DateTimeFormat>();

function formatter(
  key: string,
  locale: string | undefined,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const id = `${key}|${locale ?? ""}|${options.timeZone ?? ""}`;
  let found = cache.get(id);
  if (found === undefined) {
    found = new Intl.DateTimeFormat(locale, options);
    cache.set(id, found);
  }
  return found;
}

/** The clock time in the owner's zone, written the reader's way. */
export function formatTimeIn(
  ms: number,
  timeZone: string,
  locale?: string,
): string {
  return formatter("time", locale, {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ms));
}

/**
 * The owner's calendar date for an instant, as YYYY-MM-DD.
 *
 * en-CA rather than the reader's locale on purpose: this is an
 * identity, not a label. It groups, keys and sorts, and it must do all
 * three the same way for every reader on earth.
 */
export function dayKeyIn(ms: number, timeZone: string): string {
  return formatter("key", "en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

/** A day named the way someone scanning a phone reads it. */
export function formatDayIn(
  ms: number,
  timeZone: string,
  locale?: string,
): string {
  return formatter("day", locale, {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date(ms));
}

/**
 * The last day the answer covers.
 *
 * `horizonEndsAt` is exclusive — it is the midnight that ENDS the final
 * day — so naming it directly tells a reader about a day the page does
 * not actually describe. Stepping back an instant lands on the day it
 * really means.
 */
export function formatLastDayCovered(
  horizonEndsAt: number,
  timeZone: string,
  locale?: string,
): string {
  return formatDayIn(horizonEndsAt - 1, timeZone, locale);
}

export interface DaySlot {
  key: string;
  /** "09:00 – 12:00", in the owner's clock. */
  label: string;
}

export interface DayGroup {
  key: string;
  /** "Monday, 10 August" — scannable on a phone between calls. */
  label: string;
  /** "Today" / "Tomorrow", or null. Relative to the owner's day, since
   *  that is the day the times belong to. */
  relative: string | null;
  slots: DaySlot[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Free slots arranged into the owner's days.
 *
 * Slots are grouped by where they START. A window running to local
 * midnight ends on the following date, and filing it there would show
 * an evening under tomorrow's heading — reading, correctly but
 * uselessly, as availability on a day it is not.
 */
export function groupSlotsByDay(
  slots: readonly Slot[],
  timeZone: string,
  generatedAt: number,
  locale?: string,
): DayGroup[] {
  const today = dayKeyIn(generatedAt, timeZone);
  const tomorrow = dayKeyIn(generatedAt + DAY_MS, timeZone);

  const byDay = new Map<string, DayGroup>();
  for (const slot of [...slots].sort((a, b) => a.start - b.start)) {
    const key = dayKeyIn(slot.start, timeZone);
    let group = byDay.get(key);
    if (group === undefined) {
      group = {
        key,
        label: formatDayIn(slot.start, timeZone, locale),
        relative: key === today ? "Today" : key === tomorrow ? "Tomorrow" : null,
        slots: [],
      };
      byDay.set(key, group);
    }
    group.slots.push({
      key: `${slot.start}-${slot.end}`,
      // An en dash with spaces: "09:00-12:00" runs together at the
      // small sizes this is read at.
      label: `${formatTimeIn(slot.start, timeZone, locale)} – ${formatTimeIn(slot.end, timeZone, locale)}`,
    });
  }

  return [...byDay.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Which clock these times are on, in words a reader can act on.
 *
 * Load-bearing rather than decorative. Every time on the page is the
 * owner's local time, and a reader in another country who assumes
 * otherwise books a 09:00 that is really 04:00. The IANA id alone
 * ("Europe/London") is precise and slightly technical; the offset
 * abbreviation alone ("BST") is short and means nothing to most
 * people. Both together are unambiguous.
 */
export function formatZoneLabel(
  timeZone: string,
  at: number,
  locale?: string,
): string {
  const city = (timeZone.split("/").pop() ?? timeZone).replace(/_/g, " ");
  const parts = formatter("zone", locale, {
    timeZone,
    timeZoneName: "short",
  }).formatToParts(new Date(at));
  const abbreviation = parts.find((p) => p.type === "timeZoneName")?.value;
  // "UTC (UTC)" — when the two halves say the same thing, one of them
  // is noise.
  if (abbreviation === undefined || abbreviation === city) return city;
  return `${city} (${abbreviation})`;
}

/** When the answer was true, in the owner's zone. */
export function formatAsOf(
  generatedAt: number,
  timeZone: string,
  locale?: string,
): string {
  return formatter("asOf", locale, {
    timeZone,
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(generatedAt));
}

/**
 * What the answer was built from, said plainly.
 *
 * The "gigs" wording has to carry a warning, because that page is
 * genuinely less complete: Gigsy does not know about the dentist or a
 * job booked elsewhere. Saying so is the difference between a page
 * that is honest and one that has the user promising time they do not
 * have — which the plan calls the one outcome worse than no page.
 */
export function describeBasis(basis: PublicAvailability["basedOn"]): string {
  return basis === "gigs-and-calendar"
    ? "Based on bookings in Gigsy and this person's calendar."
    : "Based on bookings in Gigsy only — other commitments may not be shown.";
}
