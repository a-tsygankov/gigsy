/**
 * Editing a working week (Phase 12, Task 5).
 *
 * The week is `null` for a day off and `{ startMinute, endMinute }`
 * otherwise, Sunday first — the shape the projection indexes by
 * `Date#getDay`. Everything here is pure so the awkward parts (a day
 * ending at midnight, an end dragged below its start) are tested
 * without a browser.
 *
 * Times are chosen from a list rather than typed into
 * `<input type="time">`, which cannot express 24:00 at all — and a
 * shift ending at midnight is a normal thing for someone working
 * events. A list is also easier to hit on a phone.
 */

export interface WorkingDay {
  startMinute: number;
  endMinute: number;
}
export type WorkingWeek = (WorkingDay | null)[];

/** Sunday first, matching Date#getDay and the stored order. */
export const WEEKDAY_LABELS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

export const TIME_STEP_MINUTES = 30;
export const END_OF_DAY_MINUTE = 24 * 60;

/** What a day becomes when it is switched on. */
export const DEFAULT_DAY: WorkingDay = { startMinute: 9 * 60, endMinute: 17 * 60 };

/**
 * A minute-of-day as a label.
 *
 * 1440 is spelled out rather than formatted: rendering it as a clock
 * gives "12:00 AM", which reads as the START of the day and is exactly
 * backwards for the end of a shift.
 */
export function formatMinuteLabel(minute: number, locale?: string): string {
  if (minute >= END_OF_DAY_MINUTE) return "midnight";
  // A fixed UTC date, read back in UTC: this is a clock face, not an
  // instant, so no timezone may be allowed near it.
  const d = new Date(Date.UTC(2000, 0, 1, 0, minute));
  return new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

export interface TimeChoice {
  value: number;
  label: string;
}

/** Selectable times across a day. `includeEndOfDay` adds 24:00, which
 *  is a valid end and never a valid start. */
export function timeChoices(
  includeEndOfDay: boolean,
  locale?: string,
): TimeChoice[] {
  const choices: TimeChoice[] = [];
  for (let m = 0; m < END_OF_DAY_MINUTE; m += TIME_STEP_MINUTES) {
    choices.push({ value: m, label: formatMinuteLabel(m, locale) });
  }
  if (includeEndOfDay) {
    choices.push({
      value: END_OF_DAY_MINUTE,
      label: formatMinuteLabel(END_OF_DAY_MINUTE, locale),
    });
  }
  return choices;
}

/** A copy of `week` with one day replaced. Never mutates: the caller's
 *  copy is React state. */
export function setDay(
  week: WorkingWeek,
  index: number,
  day: WorkingDay | null,
): WorkingWeek {
  const next = [...week];
  next[index] = day;
  return next;
}

/** Switch a day on (at its usual hours) or off. */
export function toggleDay(week: WorkingWeek, index: number, on: boolean): WorkingWeek {
  return setDay(week, index, on ? (week[index] ?? { ...DEFAULT_DAY }) : null);
}

/**
 * Move one edge of a day, keeping the pair valid.
 *
 * The server rejects `end <= start`, and a control that lets you build
 * a rejected value and only complains on save is a control that wastes
 * your time. Dragging an edge past the other pushes the other along by
 * one step instead.
 */
export function setEdge(
  week: WorkingWeek,
  index: number,
  edge: "start" | "end",
  minute: number,
): WorkingWeek {
  const day = week[index];
  if (day == null) return week;

  if (edge === "start") {
    const startMinute = Math.min(minute, END_OF_DAY_MINUTE - TIME_STEP_MINUTES);
    return setDay(week, index, {
      startMinute,
      endMinute: Math.max(day.endMinute, startMinute + TIME_STEP_MINUTES),
    });
  }

  const endMinute = Math.max(minute, TIME_STEP_MINUTES);
  return setDay(week, index, {
    startMinute: Math.min(day.startMinute, endMinute - TIME_STEP_MINUTES),
    endMinute,
  });
}

/** How the week reads at a glance, for the section's own description. */
export function describeWeek(week: WorkingWeek, locale?: string): string {
  const working = week.filter((d): d is WorkingDay => d != null);
  if (working.length === 0) return "No working days set — your page will be empty.";

  const first = working[0]!;
  const uniform = working.every(
    (d) => d.startMinute === first.startMinute && d.endMinute === first.endMinute,
  );
  const days = `${working.length} day${working.length === 1 ? "" : "s"} a week`;
  return uniform
    ? `${days}, ${formatMinuteLabel(first.startMinute, locale)}–${formatMinuteLabel(first.endMinute, locale)}.`
    : `${days}, varying hours.`;
}
