import { describe, it, expect } from "vitest";
import {
  QUARTER_HOUR_OPTIONS,
  joinLocalInput,
  localInputToMs,
  msToLocalInput,
  splitLocalInput,
  timeOptionsFor,
} from "./datetime.ts";

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

describe("quarter-hour time options", () => {
  it("covers the whole day on the quarter, and nothing else", () => {
    expect(QUARTER_HOUR_OPTIONS).toHaveLength(96);
    expect(QUARTER_HOUR_OPTIONS[0]).toBe("00:00");
    expect(QUARTER_HOUR_OPTIONS.at(-1)).toBe("23:45");
    for (const t of QUARTER_HOUR_OPTIONS) {
      expect(t).toMatch(/^\d{2}:(00|15|30|45)$/);
    }
  });

  it("is sorted, so the wheel reads as a clock", () => {
    expect([...QUARTER_HOUR_OPTIONS].sort()).toEqual([...QUARTER_HOUR_OPTIONS]);
  });
});

describe("splitLocalInput / joinLocalInput", () => {
  it("splits a full value into its two halves", () => {
    expect(splitLocalInput("2026-09-14T14:15")).toEqual({
      date: "2026-09-14",
      time: "14:15",
    });
  });

  it("reads an empty value as two empty halves", () => {
    expect(splitLocalInput("")).toEqual({ date: "", time: "" });
  });

  it("tolerates a value with seconds, which some browsers emit", () => {
    expect(splitLocalInput("2026-09-14T14:15:00")).toEqual({
      date: "2026-09-14",
      time: "14:15",
    });
  });

  it("joins the halves back", () => {
    expect(joinLocalInput("2026-09-14", "14:15")).toBe("2026-09-14T14:15");
  });

  it("has no value at all without a date", () => {
    // A time on its own is not a moment, and emitting one would store a
    // gig at 14:15 on no particular day.
    expect(joinLocalInput("", "14:15")).toBe("");
  });

  it("round-trips", () => {
    const v = "2026-12-31T23:45";
    const { date, time } = splitLocalInput(v);
    expect(joinLocalInput(date, time)).toBe(v);
  });
});

describe("timeOptionsFor", () => {
  it("is just the grid for a time already on it", () => {
    expect(timeOptionsFor("09:30")).toEqual([...QUARTER_HOUR_OPTIONS]);
    expect(timeOptionsFor("")).toEqual([...QUARTER_HOUR_OPTIONS]);
  });

  it("keeps an off-grid time that is already stored", () => {
    // Capture extracts what the email said — 14:18 — and a <select>
    // with no such option would render blank and destroy the value on
    // the next save. It stays selectable until the user picks another.
    const options = timeOptionsFor("14:18");
    expect(options).toContain("14:18");
    expect(options).toHaveLength(97);
  });

  it("puts the off-grid time in its right place in the day", () => {
    const options = timeOptionsFor("14:18");
    expect(options.indexOf("14:18")).toBe(options.indexOf("14:15") + 1);
    expect(options.indexOf("14:30")).toBe(options.indexOf("14:18") + 1);
  });
});
