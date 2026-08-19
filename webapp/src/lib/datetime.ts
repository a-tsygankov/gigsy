/**
 * Conversions between epoch ms (storage/API) and the local-time
 * string the date + time inputs speak (YYYY-MM-DDTHH:mm).
 *
 * There is no minute grid. There used to be one — gigs snapped to the
 * quarter hour — and the whole reason `DateTimeField` split into two
 * controls was that no native picker could be held to it. Times are now
 * whatever the user (or an extracted email) says, so the split survives
 * only because a date input and a time input are genuinely better on a
 * phone than one `datetime-local`.
 */
export function msToLocalInput(ms: number | null): string {
  if (ms === null) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function localInputToMs(value: string): number | null {
  if (value === "") return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/** The two halves an `<input type="date">` and a time <select> hold. */
export function splitLocalInput(value: string): { date: string; time: string } {
  const [date = "", rest = ""] = value.split("T");
  // Some browsers hand back seconds; the select speaks HH:mm only.
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
