/**
 * Conversions between epoch ms (storage/API) and the local-time
 * string an <input type="datetime-local"> speaks (YYYY-MM-DDTHH:mm).
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

/**
 * Every quarter hour of the day, "HH:mm", ascending.
 *
 * A gig starts at :00/:15/:30/:45. Two earlier attempts to say so
 * failed, and both failed the same way — by asking the native
 * datetime-local picker to enforce it:
 *
 *   - `step={900}` does not constrain anything. It sets the desktop
 *     picker's arrow increments and marks an off-grid value
 *     `stepMismatch`, but the value is still whatever was entered, and
 *     nothing here runs native form validation before saving. **iOS
 *     ignores it outright** and shows a wheel of all sixty minutes.
 *   - Snapping the value afterwards was worse in practice: the wheel
 *     still offered 14:18, and picking it silently produced 14:15.
 *
 * A control can only offer what it contains, so the time half is a
 * <select> built from this list. On iOS that is a wheel with four
 * minute values in it, which is what was asked for; on desktop it is an
 * ordinary dropdown.
 */
export const QUARTER_HOUR_OPTIONS: readonly string[] = Array.from(
  { length: 96 },
  (_, i) => {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(Math.floor(i / 4))}:${pad((i % 4) * 15)}`;
  },
);

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

/**
 * The options to offer, given what is already stored.
 *
 * Normally just the grid. But a time can reach a gig without passing
 * through this control — capture extracts what an email actually said,
 * and that may be 14:18 — and a <select> holding no such option renders
 * blank and destroys the value on the next save. So an off-grid time is
 * added, in its right place in the day, and stays selectable until the
 * user chooses something else. Preserving what the client told you
 * beats enforcing a grid on a record of it.
 */
export function timeOptionsFor(current: string): string[] {
  if (current === "" || QUARTER_HOUR_OPTIONS.includes(current)) {
    return [...QUARTER_HOUR_OPTIONS];
  }
  return [...QUARTER_HOUR_OPTIONS, current].sort();
}
