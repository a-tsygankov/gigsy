/**
 * Presenting someone else's free time (Phase 12, Task 4).
 *
 * The rule that shapes every function here: the page speaks in the
 * OWNER's timezone, not the reader's. An agency in New York looking at
 * a London freelancer's page must see London hours, or it books a
 * 09:00 that is actually 04:00 — and the whole feature exists to stop
 * exactly that kind of confident wrongness.
 *
 * Locale still follows the reader, because "9:00 AM" versus "09:00" is
 * about how they read a clock, not which clock it is.
 */
import { describe, it, expect } from "vitest";
import {
  dayKeyIn,
  groupSlotsByDay,
  formatAsOf,
  formatLastDayCovered,
  formatTimeIn,
  formatZoneLabel,
  describeBasis,
} from "./availability.ts";

const LONDON = "Europe/London";
const NY = "America/New_York";
const at = (iso: string) => Date.parse(iso);

describe("formatTimeIn", () => {
  it("shows the owner's clock, not the reader's", () => {
    // 13:00Z is 14:00 in London. A reader anywhere must see 14:00.
    expect(formatTimeIn(at("2026-08-10T13:00:00Z"), LONDON, "en-GB")).toBe("14:00");
  });

  it("follows the reader's locale for how a clock is written", () => {
    // Same instant, same zone, different reader conventions.
    expect(formatTimeIn(at("2026-08-10T13:00:00Z"), LONDON, "en-US")).toMatch(/2:00.?PM/i);
  });

  it("uses the zone's offset on the day in question, not today's", () => {
    // 2026-01-10 is GMT in London; 2026-08-10 is BST. A fixed offset
    // would get one of them wrong.
    expect(formatTimeIn(at("2026-01-10T13:00:00Z"), LONDON, "en-GB")).toBe("13:00");
    expect(formatTimeIn(at("2026-08-10T13:00:00Z"), LONDON, "en-GB")).toBe("14:00");
  });
});

describe("dayKeyIn", () => {
  it("keys by the owner's calendar date", () => {
    expect(dayKeyIn(at("2026-08-10T13:00:00Z"), LONDON)).toBe("2026-08-10");
  });

  it("puts an instant on the day the OWNER is having", () => {
    // 02:00Z on the 10th is still the evening of the 9th in New York.
    expect(dayKeyIn(at("2026-08-10T02:00:00Z"), NY)).toBe("2026-08-09");
    expect(dayKeyIn(at("2026-08-10T02:00:00Z"), LONDON)).toBe("2026-08-10");
  });

  it("sorts lexicographically, which is why it is written this way", () => {
    const keys = [
      dayKeyIn(at("2026-09-01T12:00:00Z"), LONDON),
      dayKeyIn(at("2026-08-10T12:00:00Z"), LONDON),
    ].sort();
    expect(keys).toEqual(["2026-08-10", "2026-09-01"]);
  });
});

describe("groupSlotsByDay", () => {
  const slots = [
    { start: at("2026-08-10T08:00:00Z"), end: at("2026-08-10T11:00:00Z") },
    { start: at("2026-08-10T13:00:00Z"), end: at("2026-08-10T16:00:00Z") },
    { start: at("2026-08-11T08:00:00Z"), end: at("2026-08-11T16:00:00Z") },
  ];
  const generatedAt = at("2026-08-10T07:00:00Z");

  it("groups by the owner's day and keeps chronological order", () => {
    const days = groupSlotsByDay(slots, LONDON, generatedAt, "en-GB");

    expect(days.map((d) => d.key)).toEqual(["2026-08-10", "2026-08-11"]);
    expect(days[0]!.slots).toHaveLength(2);
    expect(days[1]!.slots).toHaveLength(1);
  });

  it("labels each slot as a range in the owner's clock", () => {
    const days = groupSlotsByDay(slots, LONDON, generatedAt, "en-GB");

    expect(days[0]!.slots[0]!.label).toBe("09:00 – 12:00");
  });

  it("names the day in a way someone can act on", () => {
    const days = groupSlotsByDay(slots, LONDON, generatedAt, "en-GB");

    // Not "2026-08-10" — an agency is scanning this between calls.
    expect(days[0]!.label).toContain("Monday");
    expect(days[0]!.label).toContain("August");
  });

  it("marks today and tomorrow relative to the OWNER", () => {
    const days = groupSlotsByDay(slots, LONDON, generatedAt, "en-GB");

    expect(days[0]!.relative).toBe("Today");
    expect(days[1]!.relative).toBe("Tomorrow");
  });

  it("leaves later days unmarked rather than counting days out", () => {
    const later = [
      { start: at("2026-08-20T08:00:00Z"), end: at("2026-08-20T11:00:00Z") },
    ];

    expect(groupSlotsByDay(later, LONDON, generatedAt, "en-GB")[0]!.relative).toBeNull();
  });

  it("groups a slot by where it starts, so a shift ending at midnight stays put", () => {
    // 18:00–24:00 London ends at exactly the next local midnight. It
    // belongs to the evening it began, not to the day after.
    const evening = [
      { start: at("2026-08-10T17:00:00Z"), end: at("2026-08-10T23:00:00Z") },
    ];

    const days = groupSlotsByDay(evening, LONDON, generatedAt, "en-GB");

    expect(days).toHaveLength(1);
    expect(days[0]!.key).toBe("2026-08-10");
    expect(days[0]!.slots[0]!.label).toBe("18:00 – 00:00");
  });

  it("returns nothing for no slots, rather than an empty day", () => {
    // A day heading with no times under it reads as a bug.
    expect(groupSlotsByDay([], LONDON, generatedAt, "en-GB")).toEqual([]);
  });

  it("gives every slot a key stable enough for a list", () => {
    const days = groupSlotsByDay(slots, LONDON, generatedAt, "en-GB");
    const keys = days.flatMap((d) => d.slots.map((s) => s.key));

    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("formatLastDayCovered", () => {
  it("names the last day described, not the midnight that ends it", () => {
    // horizonEndsAt is exclusive. Naming it directly tells the reader
    // about a day the page does not actually cover.
    const endsAt = at("2026-08-18T00:00:00+01:00"); // midnight ending the 17th

    const label = formatLastDayCovered(endsAt, LONDON, "en-GB");

    expect(label).toContain("17 August");
    expect(label).not.toContain("18");
  });
});

describe("formatZoneLabel", () => {
  it("names the city and the offset in force that day", () => {
    // Both halves earn their place: the id alone is technical, the
    // abbreviation alone means nothing to most readers.
    expect(formatZoneLabel(LONDON, at("2026-08-10T12:00:00Z"), "en-GB")).toBe(
      "London (BST)",
    );
    expect(formatZoneLabel(LONDON, at("2026-01-10T12:00:00Z"), "en-GB")).toBe(
      "London (GMT)",
    );
  });

  it("reads a multi-word zone without the underscores", () => {
    expect(formatZoneLabel(NY, at("2026-08-10T12:00:00Z"), "en-US")).toContain(
      "New York",
    );
  });

  it("falls back to the whole id when there is no region", () => {
    expect(formatZoneLabel("UTC", at("2026-08-10T12:00:00Z"), "en-GB")).toContain(
      "UTC",
    );
  });
});

describe("formatAsOf", () => {
  it("says when the answer was true, in the owner's zone", () => {
    const text = formatAsOf(at("2026-08-10T13:30:00Z"), LONDON, "en-GB");

    expect(text).toContain("10 August 2026");
    expect(text).toContain("14:30");
  });
});

describe("describeBasis", () => {
  it("does not claim the calendar was read when it was not", () => {
    // The plan's rule: silently offering slots the user cannot work is
    // the one outcome worse than no page at all.
    const text = describeBasis("gigs");

    expect(text.toLowerCase()).toContain("gigsy");
    expect(text.toLowerCase()).toContain("may not");
  });

  it("says so plainly when the calendar was included", () => {
    expect(describeBasis("gigs-and-calendar").toLowerCase()).toContain("calendar");
  });

  it("never names a client, a place, or an amount in either case", () => {
    for (const basis of ["gigs", "gigs-and-calendar"] as const) {
      expect(describeBasis(basis)).not.toMatch(/client|location|£|\$|paid/i);
    }
  });
});
