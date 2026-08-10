/// <reference types="@cloudflare/vitest-pool-workers" />
/**
 * The free-time projection (Phase 12, Task 1).
 *
 * Pure input/output, so every rule is asserted directly rather than
 * through a route. `localDayAt` is supplied as UTC here: this file is
 * about merge/mask/clamp, and timezone correctness is its own problem
 * with its own tests behind that same seam.
 */
import { describe, it, expect } from "vitest";
import {
  availableSlots,
  mergeRanges,
  subtractRanges,
  workingWindows,
  type AvailabilityOptions,
  type WorkingWeek,
} from "../src/domain/availability.ts";
import { localClock } from "../src/domain/timezone.ts";

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;

/** 2026-08-10T00:00:00Z is a Monday. */
const MON = Date.parse("2026-08-10T00:00:00.000Z");

/** Treats UTC as local, which is exactly what these rules need. */
const utcDayAt = (ms: number) => ({
  dayOfWeek: new Date(ms).getUTCDay(),
  midnightMs: Math.floor(ms / DAY) * DAY,
});

/** 9-to-5, Monday to Friday. Sunday first, matching Date#getDay. */
const NINE_TO_FIVE: WorkingWeek = [
  null,
  { startMinute: 9 * 60, endMinute: 17 * 60 },
  { startMinute: 9 * 60, endMinute: 17 * 60 },
  { startMinute: 9 * 60, endMinute: 17 * 60 },
  { startMinute: 9 * 60, endMinute: 17 * 60 },
  { startMinute: 9 * 60, endMinute: 17 * 60 },
  null,
];

function opts(over: Partial<AvailabilityOptions> = {}): AvailabilityOptions {
  return {
    now: MON,
    horizonMs: DAY,
    workingWeek: NINE_TO_FIVE,
    localDayAt: utcDayAt,
    minSlotMs: 30 * MIN,
    ...over,
  };
}

/** Readable failures: "09:00-17:00" beats a pair of epoch numbers. */
const fmt = (r: { start: number; end: number }) =>
  `${new Date(r.start).toISOString().slice(11, 16)}-${new Date(r.end)
    .toISOString()
    .slice(11, 16)}`;

describe("mergeRanges", () => {
  it("merges overlapping blocks", () => {
    const merged = mergeRanges([
      { start: 10, end: 20 },
      { start: 15, end: 30 },
    ]);
    expect(merged).toEqual([{ start: 10, end: 30 }]);
  });

  it("merges blocks that merely touch", () => {
    // Otherwise [9,10) and [10,11) invent a zero-length gap between them.
    expect(mergeRanges([
      { start: 10, end: 20 },
      { start: 20, end: 30 },
    ])).toEqual([{ start: 10, end: 30 }]);
  });

  it("leaves a real gap alone", () => {
    expect(mergeRanges([
      { start: 10, end: 20 },
      { start: 25, end: 30 },
    ])).toHaveLength(2);
  });

  it("drops empty and inverted ranges", () => {
    expect(mergeRanges([
      { start: 10, end: 10 },
      { start: 30, end: 20 },
    ])).toEqual([]);
  });

  it("does not depend on input order", () => {
    expect(mergeRanges([
      { start: 25, end: 30 },
      { start: 10, end: 20 },
    ])).toEqual([
      { start: 10, end: 20 },
      { start: 25, end: 30 },
    ]);
  });

  it("does not mutate its input", () => {
    const input = [{ start: 10, end: 20 }, { start: 15, end: 30 }];
    mergeRanges(input);
    expect(input[0]).toEqual({ start: 10, end: 20 });
  });
});

describe("subtractRanges", () => {
  it("returns the whole span when nothing is busy", () => {
    expect(subtractRanges({ start: 0, end: 100 }, [])).toEqual([
      { start: 0, end: 100 },
    ]);
  });

  it("splits the span around a block in the middle", () => {
    expect(subtractRanges({ start: 0, end: 100 }, [{ start: 40, end: 60 }])).toEqual([
      { start: 0, end: 40 },
      { start: 60, end: 100 },
    ]);
  });

  it("returns nothing when the span is fully covered", () => {
    expect(subtractRanges({ start: 0, end: 100 }, [{ start: 0, end: 100 }])).toEqual([]);
  });

  it("ignores blocks entirely outside the span", () => {
    expect(
      subtractRanges({ start: 50, end: 100 }, [
        { start: 0, end: 10 },
        { start: 200, end: 300 },
      ]),
    ).toEqual([{ start: 50, end: 100 }]);
  });

  it("clips a block that overhangs the start", () => {
    expect(subtractRanges({ start: 50, end: 100 }, [{ start: 0, end: 60 }])).toEqual([
      { start: 60, end: 100 },
    ]);
  });
});

describe("workingWindows", () => {
  it("emits one window per working day", () => {
    const windows = workingWindows(MON, MON + 3 * DAY, {
      workingWeek: NINE_TO_FIVE,
      localDayAt: utcDayAt,
    });
    expect(windows).toHaveLength(3);
    expect(fmt(windows[0]!)).toBe("09:00-17:00");
  });

  it("skips days off entirely", () => {
    // Saturday and Sunday are null, not zero-length: a day off is not a
    // day with no hours, and the distinction shows up here.
    const saturday = MON + 5 * DAY;
    const windows = workingWindows(saturday, saturday + 2 * DAY, {
      workingWeek: NINE_TO_FIVE,
      localDayAt: utcDayAt,
    });
    expect(windows).toEqual([]);
  });
});

describe("availableSlots", () => {
  it("offers the working day when nothing is booked", () => {
    const slots = availableSlots([], opts());
    expect(slots.map(fmt)).toEqual(["09:00-17:00"]);
  });

  it("splits the day around a booked gig", () => {
    const gig = { start: MON + 12 * HOUR, end: MON + 14 * HOUR };
    expect(availableSlots([gig], opts()).map(fmt)).toEqual([
      "09:00-12:00",
      "14:00-17:00",
    ]);
  });

  it("never offers the past", () => {
    // The horizon moves with `now`, so a page loaded at noon must not
    // suggest the morning. Held inside one day on purpose: fmt shows
    // only the clock, and a 24h horizon would also return TUESDAY 09:00
    // - correct, but indistinguishable here from the bug being tested.
    const slots = availableSlots([], opts({ now: MON + 12 * HOUR, horizonMs: 5 * HOUR }));
    expect(slots.map(fmt)).toEqual(["12:00-17:00"]);
  });

  it("ignores gigs outside working hours", () => {
    const evening = { start: MON + 19 * HOUR, end: MON + 22 * HOUR };
    expect(availableSlots([evening], opts()).map(fmt)).toEqual(["09:00-17:00"]);
  });

  it("drops gaps too short to be worth offering", () => {
    // 20 minutes between two gigs is not availability.
    const before = { start: MON + 9 * HOUR, end: MON + 12 * HOUR };
    const after = { start: MON + 12 * HOUR + 20 * MIN, end: MON + 17 * HOUR };

    expect(availableSlots([before, after], opts()).map(fmt)).toEqual([]);
  });

  it("keeps a gap exactly at the minimum", () => {
    const before = { start: MON + 9 * HOUR, end: MON + 12 * HOUR };
    const after = { start: MON + 12 * HOUR + 30 * MIN, end: MON + 17 * HOUR };

    expect(availableSlots([before, after], opts()).map(fmt)).toEqual([
      "12:00-12:30",
    ]);
  });

  it("stops at the horizon", () => {
    const slots = availableSlots([], opts({ horizonMs: 7 * DAY }));
    // Mon-Fri only; the weekend has no hours.
    expect(slots).toHaveLength(5);
  });

  it("returns nothing when the horizon has already passed", () => {
    expect(availableSlots([], opts({ horizonMs: 0 }))).toEqual([]);
  });

  it("treats overlapping gigs as one block", () => {
    const a = { start: MON + 10 * HOUR, end: MON + 13 * HOUR };
    const b = { start: MON + 12 * HOUR, end: MON + 15 * HOUR };

    expect(availableSlots([a, b], opts()).map(fmt)).toEqual([
      "09:00-10:00",
      "15:00-17:00",
    ]);
  });

  it("offers nothing on a fully booked day", () => {
    const all = { start: MON + 8 * HOUR, end: MON + 18 * HOUR };
    expect(availableSlots([all], opts())).toEqual([]);
  });
});

/**
 * The seam Task 1 left open, now driven by a real zone.
 *
 * `midnightMs + startMinute` is right on 363 days a year. On the other
 * two it is an hour out, and an hour out on a page an agency books
 * from is the failure this whole phase exists to avoid — so the offset
 * is asked of the clock rather than assumed.
 */
describe("availableSlots across a DST change", () => {
  const NY = localClock("America/New_York");
  const EVERY_DAY: WorkingWeek = Array.from({ length: 7 }, () => ({
    startMinute: 9 * 60,
    endMinute: 17 * 60,
  }));

  function inNewYork(over: Partial<AvailabilityOptions> = {}): AvailabilityOptions {
    return {
      now: 0,
      horizonMs: DAY,
      workingWeek: EVERY_DAY,
      localDayAt: NY.localDayAt,
      localMinuteAt: NY.localMinuteAt,
      minSlotMs: 30 * MIN,
      ...over,
    };
  }

  it("holds 09:00 local on the day that gains an hour", () => {
    // 2026-11-01: 02:00 EDT falls back to 01:00 EST, so the day is 25
    // hours long. 09:00 local is 14:00Z — midnight (04:00Z) plus NINE
    // hours would be 13:00Z, which is 08:00 to the reader.
    const midnight = Date.parse("2026-11-01T04:00:00.000Z");

    const slots = availableSlots([], inNewYork({ now: midnight, horizonMs: DAY }));

    expect(slots[0]!.start).toBe(Date.parse("2026-11-01T14:00:00.000Z"));
    expect(slots[0]!.end).toBe(Date.parse("2026-11-01T22:00:00.000Z"));
  });

  it("holds 09:00 local on the day that loses an hour", () => {
    // 2026-03-08: 02:00 EST becomes 03:00 EDT. 09:00 local is 13:00Z;
    // midnight (05:00Z) plus nine would be 14:00Z — an hour late.
    const midnight = Date.parse("2026-03-08T05:00:00.000Z");

    const slots = availableSlots([], inNewYork({ now: midnight, horizonMs: DAY }));

    expect(slots[0]!.start).toBe(Date.parse("2026-03-08T13:00:00.000Z"));
    expect(slots[0]!.end).toBe(Date.parse("2026-03-08T21:00:00.000Z"));
  });

  it("still subtracts a gig booked in local terms on such a day", () => {
    const midnight = Date.parse("2026-11-01T04:00:00.000Z");
    // Noon to 14:00 local, i.e. 17:00Z-19:00Z under EST.
    const gig = {
      start: Date.parse("2026-11-01T17:00:00.000Z"),
      end: Date.parse("2026-11-01T19:00:00.000Z"),
    };

    const slots = availableSlots([gig], inNewYork({ now: midnight, horizonMs: DAY }));

    expect(slots.map((s) => [s.start, s.end])).toEqual([
      [Date.parse("2026-11-01T14:00:00.000Z"), Date.parse("2026-11-01T17:00:00.000Z")],
      [Date.parse("2026-11-01T19:00:00.000Z"), Date.parse("2026-11-01T22:00:00.000Z")],
    ]);
  });

  it("defaults to plain arithmetic when no clock is supplied", () => {
    // Every existing caller — and every test above — omits
    // localMinuteAt. The seam must be additive, not a breaking change.
    const windows = workingWindows(MON, MON + DAY, {
      workingWeek: NINE_TO_FIVE,
      localDayAt: utcDayAt,
    });

    expect(windows[0]).toEqual({ start: MON + 9 * HOUR, end: MON + 17 * HOUR });
  });
});
