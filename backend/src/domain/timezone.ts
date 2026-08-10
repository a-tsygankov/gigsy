/**
 * IANA timezone arithmetic for the availability projection (Phase 12).
 *
 * Task 1 deliberately injected `localDayAt` instead of solving this,
 * so the merge/mask/clamp rules would not be hostage to DST. This is
 * the other side of that seam, and it exists because two questions
 * that look identical are not:
 *
 *   midnight + 9h          — nine hours after the day began
 *   localMinuteAt(mid, 540) — the instant the local clock reads 09:00
 *
 * On the two days a year a zone shifts, those differ by an hour. The
 * first is what naive code computes; the second is what an agency
 * reads off the page. Everything here is built on `Intl`, which owns
 * the transition table, rather than on stored offsets, which rot.
 */

/** Sunday-first, matching Date#getDay and the WorkingWeek ordering. */
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Formatters are not cheap to build and a request makes many calls. */
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = FORMATTERS.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      // h23 rather than hour12:false — the latter still yields "24" for
      // midnight in some implementations, which parses as the wrong day.
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    FORMATTERS.set(timeZone, formatter);
  }
  return formatter;
}

/** Whether `Intl` recognises the zone. Settings are checked with this
 *  so an unknown value is refused at the edge rather than thrown
 *  inside an unauthenticated request. */
export function isSupportedTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  dayOfWeek: number;
}

function wallClockAt(timeZone: string, ms: number): WallClock {
  const parts = formatterFor(timeZone).formatToParts(new Date(ms));
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "0";

  return {
    year: Number(value("year")),
    month: Number(value("month")),
    day: Number(value("day")),
    hour: Number(value("hour")),
    minute: Number(value("minute")),
    second: Number(value("second")),
    dayOfWeek: Math.max(0, WEEKDAYS.indexOf(value("weekday") as never)),
  };
}

/** Milliseconds elapsed on the local clock since it last read 00:00. */
function clockMsOfDay(w: WallClock): number {
  return ((w.hour * 60 + w.minute) * 60 + w.second) * 1000;
}

function isSameDate(a: WallClock, b: WallClock): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

/** The zone's offset from UTC at an instant, in ms (west is negative). */
function offsetAt(timeZone: string, ms: number): number {
  const w = wallClockAt(timeZone, ms);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

export interface LocalDay {
  /** 0 = Sunday, indexing WorkingWeek. */
  dayOfWeek: number;
  /** The first instant of this local day. */
  midnightMs: number;
}

export interface LocalClock {
  localDayAt(ms: number): LocalDay;
  /**
   * The instant at which the local clock reads `minute` minutes past
   * midnight on the day beginning at `midnightMs`. 1440 means the end
   * of the day, so a shift written as 24:00 lands on the next midnight
   * rather than inverting its own window.
   */
  localMinuteAt(midnightMs: number, minute: number): number;
}

/**
 * A clock for one zone.
 *
 * `localDayAt` walks back to midnight by subtracting the local
 * time-of-day and re-reading, rather than by arithmetic on an assumed
 * offset. Two or three passes converge; the loop is bounded because a
 * day with no midnight at all (Chile shifts at 24:00) has no fixed
 * point to converge on, and the honest answer there is the earliest
 * instant that genuinely belongs to that date — which is what `best`
 * accumulates.
 */
export function localClock(timeZone: string): LocalClock {
  return {
    localDayAt(ms: number): LocalDay {
      const target = wallClockAt(timeZone, ms);
      let candidate = Math.floor(ms / 1000) * 1000;
      let best = candidate;

      for (let pass = 0; pass < 4; pass++) {
        const here = wallClockAt(timeZone, candidate);
        if (isSameDate(here, target)) {
          if (candidate < best) best = candidate;
          const elapsed = clockMsOfDay(here);
          if (elapsed === 0) return { dayOfWeek: target.dayOfWeek, midnightMs: candidate };
          candidate -= elapsed;
        } else {
          // Overshot into the previous day; step forward to its end,
          // which is the first instant of the day we want.
          candidate += DAY_MS - clockMsOfDay(here);
        }
      }

      return { dayOfWeek: target.dayOfWeek, midnightMs: best };
    },

    localMinuteAt(midnightMs: number, minute: number): number {
      const day = wallClockAt(timeZone, midnightMs);
      const asUtc = Date.UTC(day.year, day.month - 1, day.day) + minute * MINUTE_MS;

      // Two passes: the first guess uses the offset at the naive
      // instant, the second uses the offset where that guess landed.
      // That is enough unless the wall time does not exist at all.
      let guess = asUtc - offsetAt(timeZone, asUtc);
      guess = asUtc - offsetAt(timeZone, guess);

      // A wall time inside a spring-forward gap resolves to an instant
      // before the day began. Clamping keeps the previous evening out
      // of a working window — it is someone's evening, not availability.
      return Math.max(guess, midnightMs);
    },
  };
}
