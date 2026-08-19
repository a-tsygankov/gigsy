/**
 * Conversions between epoch ms (storage/API) and the local-time
 * string `DateTimeField` speaks (YYYY-MM-DDTHH:mm).
 *
 * There is no minute grid. There used to be one — gigs snapped to the
 * quarter hour — and it is why the control was two native inputs for a
 * while: no picker could be held to a grid. That is over twice now. The
 * grid is gone, and the control is a single shadcn calendar-in-a-popover
 * plus a time field, so a moment is captured in one place.
 *
 * The split lives on only in here, as a shape: a calendar hands back a
 * day and a time input hands back an hour, and something has to put them
 * together and take them apart again.
 */

/** The `YYYY-MM-DD` a `Date` falls on **locally**.
 *
 *  Not `toISOString().slice(0, 10)`: that converts to UTC first, so
 *  anyone west of Greenwich gets yesterday for an evening gig. */
export function dateToLocalDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function msToLocalInput(ms: number | null): string {
  if (ms === null) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${dateToLocalDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function localInputToMs(value: string): number | null {
  if (value === "") return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/** The day and the time a moment is made of — what the calendar and the
 *  time input each hold. */
export function splitLocalInput(value: string): { date: string; time: string } {
  const [date = "", rest = ""] = value.split("T");
  // Some browsers hand back seconds; the time input speaks HH:mm only.
  return { date, time: rest.slice(0, 5) };
}

/**
 * Put them back together.
 *
 * No date means no value, whatever the time says: a time on its own is
 * not a moment, and emitting one would file a gig at 14:15 on no
 * particular day.
 */
export function joinLocalInput(date: string, time: string): string {
  if (date === "") return "";
  return `${date}T${time}`;
}

/**
 * A moment as a person reads it: "Sat, Sep 12, 10:00 AM".
 *
 * Shared by the gig list and by `DateTimeField`'s trigger on purpose —
 * the row you tap to edit a moment and the row that lists it are the
 * same moment, and two copies of these options would eventually
 * disagree about it.
 */
export function formatLocalMoment(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * A local date string (`YYYY-MM-DD`) as a `Date` at local midnight.
 *
 * `new Date("2026-09-12")` parses a bare date as UTC, which lands on the
 * 11th for most of the Americas — and the calendar would then highlight
 * the wrong day. The three-argument constructor is local by definition.
 */
export function localDateToDate(date: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (m === null) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}
