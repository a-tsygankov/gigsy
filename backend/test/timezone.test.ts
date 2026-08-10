/// <reference types="@cloudflare/vitest-pool-workers" />
/**
 * The timezone seam (Phase 12, Task 2).
 *
 * Task 1 injected `localDayAt` rather than solving zones, on the
 * grounds that DST is its own problem with its own tests. This is that
 * problem and those tests.
 *
 * Everything here is asserted against instants, never against a
 * formatted string: the question "which instant is 09:00 local on this
 * day" is the one the projection actually asks, and it is the one that
 * a naive `midnight + 9h` gets wrong twice a year.
 */
import { describe, it, expect } from "vitest";
import { isSupportedTimeZone, localClock } from "../src/domain/timezone.ts";

const HOUR = 60 * 60 * 1000;
const at = (iso: string) => Date.parse(iso);

describe("localClock — the local day", () => {
  it("treats UTC as itself", () => {
    const clock = localClock("UTC");
    const day = clock.localDayAt(at("2026-08-10T14:00:00Z"));

    expect(day.midnightMs).toBe(at("2026-08-10T00:00:00Z"));
    expect(day.dayOfWeek).toBe(1); // Monday
  });

  it("finds local midnight behind a western offset", () => {
    // 14:00Z is 10:00 in New York, so the day began at 04:00Z.
    const day = localClock("America/New_York").localDayAt(at("2026-08-10T14:00:00Z"));

    expect(day.midnightMs).toBe(at("2026-08-10T04:00:00Z"));
    expect(day.dayOfWeek).toBe(1);
  });

  it("reports the LOCAL weekday, not the UTC one", () => {
    // 02:00Z Monday is still Sunday evening in New York. Getting this
    // wrong would offer an agency Monday's working hours on a Sunday.
    const day = localClock("America/New_York").localDayAt(at("2026-08-10T02:00:00Z"));

    expect(day.dayOfWeek).toBe(0); // Sunday
    expect(day.midnightMs).toBe(at("2026-08-09T04:00:00Z"));
  });

  it("handles an offset that is not a whole number of hours", () => {
    const day = localClock("Asia/Kolkata").localDayAt(at("2026-08-10T00:00:00Z"));

    // 00:00Z is 05:30 IST, so the local day started at 18:30Z the day before.
    expect(day.midnightMs).toBe(at("2026-08-09T18:30:00Z"));
    expect(day.dayOfWeek).toBe(1);
  });

  it("is idempotent: midnight's own day is itself", () => {
    const clock = localClock("America/New_York");
    const first = clock.localDayAt(at("2026-08-10T14:00:00Z"));
    const again = clock.localDayAt(first.midnightMs);

    expect(again.midnightMs).toBe(first.midnightMs);
    expect(again.dayOfWeek).toBe(first.dayOfWeek);
  });

  it("finds midnight on a day that lost an hour", () => {
    // 2026-03-08, New York: 02:00 EST becomes 03:00 EDT. Midnight is
    // still midnight; it is the rest of the day that shifts.
    const day = localClock("America/New_York").localDayAt(at("2026-03-08T18:00:00Z"));

    expect(day.midnightMs).toBe(at("2026-03-08T05:00:00Z"));
  });

  it("finds midnight on a day that gained an hour", () => {
    // 2026-11-01, New York: 02:00 EDT falls back to 01:00 EST.
    const day = localClock("America/New_York").localDayAt(at("2026-11-01T18:00:00Z"));

    expect(day.midnightMs).toBe(at("2026-11-01T04:00:00Z"));
  });

  it("starts a day that has no midnight at its first real instant", () => {
    // Chile moves to DST at 24:00, so 2026-09-06 begins at 01:00 local.
    // There is no 00:00 to find, and the honest answer is the earliest
    // instant that is actually that day — not an hour of the day before.
    const day = localClock("America/Santiago").localDayAt(at("2026-09-06T12:00:00Z"));

    expect(day.midnightMs).toBe(at("2026-09-06T04:00:00Z"));
    expect(day.dayOfWeek).toBe(0); // Sunday
  });
});

describe("localClock — a minute past local midnight", () => {
  it("is plain arithmetic on an ordinary day", () => {
    const clock = localClock("America/New_York");
    const midnight = at("2026-08-10T04:00:00Z");

    expect(clock.localMinuteAt(midnight, 9 * 60)).toBe(at("2026-08-10T13:00:00Z"));
  });

  it("is NOT midnight plus the minutes when the day lost an hour", () => {
    // The whole reason this function exists. 09:00 EDT is 13:00Z, but
    // midnight (05:00Z) plus nine hours is 14:00Z — an hour late, and
    // an agency told the wrong time.
    const clock = localClock("America/New_York");
    const midnight = at("2026-03-08T05:00:00Z");

    expect(clock.localMinuteAt(midnight, 9 * 60)).toBe(at("2026-03-08T13:00:00Z"));
    expect(clock.localMinuteAt(midnight, 9 * 60)).not.toBe(midnight + 9 * HOUR);
  });

  it("is NOT midnight plus the minutes when the day gained an hour", () => {
    // The same error in the other direction: 09:00 EST is 14:00Z,
    // midnight (04:00Z) plus nine is 13:00Z — an hour early.
    const clock = localClock("America/New_York");
    const midnight = at("2026-11-01T04:00:00Z");

    expect(clock.localMinuteAt(midnight, 9 * 60)).toBe(at("2026-11-01T14:00:00Z"));
    expect(clock.localMinuteAt(midnight, 9 * 60)).not.toBe(midnight + 9 * HOUR);
  });

  it("never returns an instant before the day it was asked about", () => {
    // 00:30 does not exist on Chile's transition day. Clamping to the
    // start of the day is the only answer that cannot leak an hour of
    // the previous evening into a working window.
    const clock = localClock("America/Santiago");
    const midnight = at("2026-09-06T04:00:00Z");

    expect(clock.localMinuteAt(midnight, 30)).toBeGreaterThanOrEqual(midnight);
  });

  it("takes 1440 as the end of the day, not the start of it", () => {
    // A shift ending at midnight is written as 24:00, and must land on
    // the NEXT midnight or every such window would be inverted.
    const clock = localClock("America/New_York");
    const midnight = at("2026-08-10T04:00:00Z");

    expect(clock.localMinuteAt(midnight, 1440)).toBe(at("2026-08-11T04:00:00Z"));
  });

  it("crosses a fall-back boundary with the right elapsed time", () => {
    // Midnight to 24:00 on 2026-11-01 is 25 real hours.
    const clock = localClock("America/New_York");
    const midnight = at("2026-11-01T04:00:00Z");

    expect(clock.localMinuteAt(midnight, 1440) - midnight).toBe(25 * HOUR);
  });
});

describe("isSupportedTimeZone", () => {
  it("accepts real IANA zones", () => {
    expect(isSupportedTimeZone("UTC")).toBe(true);
    expect(isSupportedTimeZone("America/New_York")).toBe(true);
    expect(isSupportedTimeZone("Asia/Kolkata")).toBe(true);
  });

  it("rejects anything Intl cannot resolve", () => {
    // A settings value that reaches the projection unchecked would throw
    // inside a public request; better to refuse it at the edge.
    expect(isSupportedTimeZone("Mars/Olympus_Mons")).toBe(false);
    expect(isSupportedTimeZone("")).toBe(false);
    expect(isSupportedTimeZone("EST5EDT ")).toBe(false);
  });
});
