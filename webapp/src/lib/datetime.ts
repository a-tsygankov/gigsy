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

const QUARTER_HOUR_MS = 15 * 60 * 1000;

/**
 * Round a datetime-local value onto the quarter-hour grid.
 *
 * A gig starts at :00/:15/:30/:45, not 10:07. `step={900}` on the input
 * was the first attempt at saying so and does not say it: step drives
 * the picker's granularity and flags an odd value as `stepMismatch`,
 * but the value is still whatever was typed, and nothing runs native
 * form validation before saving. Enforcing it here makes the rule true
 * on every platform rather than on whichever ones honour step.
 *
 * Nearest, not down: rounding 10:59 down to 10:45 is a bigger lie than
 * rounding it up to 11:00.
 *
 * Arithmetic goes through epoch ms so that carrying past midnight, a
 * month end or a year end costs nothing to get right. Safe for every
 * real timezone: UTC offsets are all whole multiples of 15 minutes, so
 * the grid lines up in local time too.
 *
 * A value that will not parse is returned untouched — half-typed states
 * reach onChange in some browsers, and snapping those into a real date
 * would fight the person typing.
 */
export function snapToQuarterHour(value: string): string {
  const ms = localInputToMs(value);
  if (ms === null) return value;
  return msToLocalInput(Math.round(ms / QUARTER_HOUR_MS) * QUARTER_HOUR_MS);
}
