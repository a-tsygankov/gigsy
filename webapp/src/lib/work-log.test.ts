import { describe, expect, it } from "vitest";
import { MAX_BREAK_MINUTES, workLogProblem } from "./work-log.ts";

const HOUR = 3_600_000;

describe("workLogProblem", () => {
  it("passes an empty log, an open shift and a sane closed one", () => {
    expect(workLogProblem(null, null, null)).toBeNull();
    expect(workLogProblem(1_000, null, null)).toBeNull();
    expect(workLogProblem(0, HOUR, 15)).toBeNull();
  });

  describe("the breakMinutes field rule (schemas.ts: int, 0…1440)", () => {
    // Every case here has NO end stamp, which is the point: the three
    // cross-field rules below all need both ends, so before this rule
    // existed each of these committed, synced, 400d, and was dropped by
    // sync-engine with only a warn.
    it("refuses a fraction of a minute", () => {
      expect(workLogProblem(0, null, 18.5)).toBe("Breaks are counted in whole minutes.");
    });

    it("refuses a break that is not a number at all", () => {
      expect(workLogProblem(0, null, Number.NaN)).toBe(
        "Breaks are counted in whole minutes.",
      );
    });

    it("refuses a negative break", () => {
      expect(workLogProblem(0, null, -5)).toBe("A break can't be negative.");
    });

    it("refuses a break longer than the schema's day-long ceiling", () => {
      expect(workLogProblem(0, null, MAX_BREAK_MINUTES + 1)).toBe(
        "That break is longer than a day — check the number.",
      );
      expect(workLogProblem(0, null, 2000)).not.toBeNull();
    });

    it("allows the ceiling itself, and zero", () => {
      expect(workLogProblem(null, null, MAX_BREAK_MINUTES)).toBeNull();
      expect(workLogProblem(null, null, 0)).toBeNull();
    });

    it("is checked before the cross-field rules", () => {
      // Both faults at once: the field rule is the one reported, since
      // it is the one that names the box the person is typing in.
      expect(workLogProblem(HOUR, 0, 18.5)).toBe("Breaks are counted in whole minutes.");
    });
  });

  describe("the cross-field rules (schemas.ts: superRefine)", () => {
    it("refuses an end with no start", () => {
      expect(workLogProblem(null, 1_000, null)).toBe(
        "Work can't end without a start time.",
      );
    });

    it("refuses an end at or before the start", () => {
      expect(workLogProblem(2_000, 2_000, null)).toBe("Finished must be after Started.");
      expect(workLogProblem(2_000, 1_000, null)).toBe("Finished must be after Started.");
    });

    it("refuses a break that fills the whole shift", () => {
      expect(workLogProblem(0, HOUR, 60)).toBe("The break can't fill the whole shift.");
      expect(workLogProblem(0, HOUR, 61)).toBe("The break can't fill the whole shift.");
      expect(workLogProblem(0, HOUR, 59)).toBeNull();
    });
  });
});
