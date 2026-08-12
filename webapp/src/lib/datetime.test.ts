import { describe, it, expect } from "vitest";
import { localInputToMs, msToLocalInput, snapToQuarterHour } from "./datetime.ts";

describe("datetime-local input conversion", () => {
  it("round-trips epoch ms through the input format", () => {
    const ms = new Date(2026, 8, 12, 14, 30).getTime(); // local time
    expect(localInputToMs(msToLocalInput(ms))).toBe(ms);
  });

  it("formats as YYYY-MM-DDTHH:mm (input[type=datetime-local] shape)", () => {
    const ms = new Date(2026, 0, 5, 9, 7).getTime();
    expect(msToLocalInput(ms)).toBe("2026-01-05T09:07");
  });

  it("returns null for an empty input value", () => {
    expect(localInputToMs("")).toBeNull();
  });

  it("handles the empty-ms side with an empty string", () => {
    expect(msToLocalInput(null)).toBe("");
  });
});

/**
 * Snapping gig times to the quarter-hour grid.
 *
 * `step={900}` on the input was the first attempt and is not a
 * constraint: it drives the picker's granularity and marks an odd value
 * `stepMismatch`, but nothing stops a typed 10:07 from being the
 * field's value, and nothing here runs native form validation before
 * saving. The rule has to live in code to be a rule.
 *
 * Rounding is to the NEAREST quarter, not down. Down would turn a
 * carefully typed 10:59 into 10:45, which is a bigger lie than 11:00.
 */
describe("snapToQuarterHour", () => {
  it("leaves a time already on the grid alone", () => {
    for (const t of ["09:00", "09:15", "09:30", "09:45"]) {
      expect(snapToQuarterHour(`2026-08-11T${t}`)).toBe(`2026-08-11T${t}`);
    }
  });

  it("rounds to the nearest quarter", () => {
    expect(snapToQuarterHour("2026-08-11T10:07")).toBe("2026-08-11T10:00");
    expect(snapToQuarterHour("2026-08-11T10:08")).toBe("2026-08-11T10:15");
    expect(snapToQuarterHour("2026-08-11T10:23")).toBe("2026-08-11T10:30");
    expect(snapToQuarterHour("2026-08-11T10:38")).toBe("2026-08-11T10:45");
  });

  it("carries into the next hour", () => {
    expect(snapToQuarterHour("2026-08-11T10:53")).toBe("2026-08-11T11:00");
  });

  it("carries into the next day, month and year", () => {
    expect(snapToQuarterHour("2026-08-11T23:53")).toBe("2026-08-12T00:00");
    expect(snapToQuarterHour("2026-08-31T23:53")).toBe("2026-09-01T00:00");
    expect(snapToQuarterHour("2026-12-31T23:53")).toBe("2027-01-01T00:00");
  });

  it("keeps an empty field empty rather than inventing a time", () => {
    expect(snapToQuarterHour("")).toBe("");
  });

  it("returns an unparseable value untouched", () => {
    // Mid-edit states reach onChange in some browsers. Snapping garbage
    // into a real date would be worse than leaving it for the user.
    expect(snapToQuarterHour("not-a-date")).toBe("not-a-date");
    expect(snapToQuarterHour("2026-08-11T")).toBe("2026-08-11T");
  });

  it("is idempotent", () => {
    const once = snapToQuarterHour("2026-08-11T10:07");
    expect(snapToQuarterHour(once)).toBe(once);
  });
});
