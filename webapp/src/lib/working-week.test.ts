/**
 * Editing a working week (Phase 12, Task 5).
 *
 * The rule these tests defend: the editor cannot build a value the
 * server will reject. A control that lets you make an invalid week and
 * only complains when you save is a control that wastes your time —
 * and this one is editing what strangers will see, so a save that
 * silently fails is worse than usual.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_DAY,
  END_OF_DAY_MINUTE,
  TIME_STEP_MINUTES,
  describeWeek,
  formatMinuteLabel,
  setEdge,
  timeChoices,
  toggleDay,
  type WorkingWeek,
} from "./working-week.ts";

const off: WorkingWeek = [null, null, null, null, null, null, null];
const nineToFive: WorkingWeek = [
  null,
  { startMinute: 540, endMinute: 1020 },
  { startMinute: 540, endMinute: 1020 },
  { startMinute: 540, endMinute: 1020 },
  { startMinute: 540, endMinute: 1020 },
  { startMinute: 540, endMinute: 1020 },
  null,
];

describe("formatMinuteLabel", () => {
  it("spells out the end of the day rather than showing a clock", () => {
    // "12:00 AM" reads as the START of a day, which is exactly
    // backwards for the end of a shift.
    expect(formatMinuteLabel(END_OF_DAY_MINUTE, "en-GB")).toBe("midnight");
  });

  it("shows a clock face, never a timezone-shifted instant", () => {
    expect(formatMinuteLabel(540, "en-GB")).toBe("09:00");
    expect(formatMinuteLabel(0, "en-GB")).toBe("00:00");
  });
});

describe("timeChoices", () => {
  it("covers the day in half-hour steps", () => {
    const choices = timeChoices(false, "en-GB");

    expect(choices).toHaveLength((24 * 60) / TIME_STEP_MINUTES);
    expect(choices[0]!.value).toBe(0);
    expect(choices.at(-1)!.value).toBe(24 * 60 - TIME_STEP_MINUTES);
  });

  it("offers midnight as an end, and never as a start", () => {
    // A shift ending at midnight is ordinary for event work; a shift
    // starting at 24:00 is nonsense.
    expect(timeChoices(true, "en-GB").at(-1)!.value).toBe(END_OF_DAY_MINUTE);
    expect(timeChoices(false, "en-GB").some((c) => c.value === END_OF_DAY_MINUTE)).toBe(
      false,
    );
  });
});

describe("toggleDay", () => {
  it("switches a day on at the usual hours", () => {
    expect(toggleDay(off, 1, true)[1]).toEqual(DEFAULT_DAY);
  });

  it("switches a day off without touching the others", () => {
    const next = toggleDay(nineToFive, 1, false);

    expect(next[1]).toBeNull();
    expect(next[2]).toEqual(nineToFive[2]);
  });

  it("gives back the hours a day had when it is switched on again", () => {
    const custom: WorkingWeek = [...off];
    custom[3] = { startMinute: 600, endMinute: 1200 };

    // Off then on within one edit session should not silently reset to
    // 9-5 and lose what the user typed.
    expect(toggleDay(custom, 3, true)[3]).toEqual({ startMinute: 600, endMinute: 1200 });
  });

  it("does not mutate the week it was given", () => {
    const before = JSON.stringify(nineToFive);
    toggleDay(nineToFive, 1, false);

    expect(JSON.stringify(nineToFive)).toBe(before);
  });
});

describe("setEdge", () => {
  it("moves the start", () => {
    expect(setEdge(nineToFive, 1, "start", 480)[1]).toEqual({
      startMinute: 480,
      endMinute: 1020,
    });
  });

  it("moves the end", () => {
    expect(setEdge(nineToFive, 1, "end", 1200)[1]).toEqual({
      startMinute: 540,
      endMinute: 1200,
    });
  });

  it("pushes the end along rather than letting the start pass it", () => {
    // The server rejects end <= start. The editor must not be able to
    // produce it in the first place.
    const next = setEdge(nineToFive, 1, "start", 1080)[1]!;

    expect(next.startMinute).toBe(1080);
    expect(next.endMinute).toBeGreaterThan(next.startMinute);
  });

  it("pushes the start along rather than letting the end pass it", () => {
    const next = setEdge(nineToFive, 1, "end", 480)[1]!;

    expect(next.endMinute).toBe(480);
    expect(next.startMinute).toBeLessThan(next.endMinute);
  });

  it("never produces a zero-length day", () => {
    const next = setEdge(nineToFive, 1, "end", 540)[1]!;

    expect(next.endMinute).toBeGreaterThan(next.startMinute);
  });

  it("keeps a shift that ends at midnight valid", () => {
    const next = setEdge(nineToFive, 1, "end", END_OF_DAY_MINUTE)[1]!;

    expect(next.endMinute).toBe(END_OF_DAY_MINUTE);
    expect(next.startMinute).toBeLessThan(END_OF_DAY_MINUTE);
  });

  it("leaves a day off alone", () => {
    expect(setEdge(off, 1, "start", 600)).toEqual(off);
  });
});

describe("describeWeek", () => {
  it("warns plainly when nothing is set", () => {
    // An empty page is a real outcome and the user should hear it here,
    // not discover it from an agency.
    expect(describeWeek(off, "en-GB")).toContain("empty");
  });

  it("states uniform hours once", () => {
    expect(describeWeek(nineToFive, "en-GB")).toBe("5 days a week, 09:00–17:00.");
  });

  it("does not pretend varying hours are uniform", () => {
    const varied = [...nineToFive];
    varied[2] = { startMinute: 600, endMinute: 1320 };

    expect(describeWeek(varied, "en-GB")).toContain("varying");
  });

  it("counts a single day correctly", () => {
    const one = [...off];
    one[1] = { ...DEFAULT_DAY };

    expect(describeWeek(one, "en-GB")).toContain("1 day a week");
  });
});
