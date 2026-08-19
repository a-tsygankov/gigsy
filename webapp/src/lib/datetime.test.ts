import { describe, it, expect } from "vitest";
import {
  joinLocalInput,
  localInputToMs,
  msToLocalInput,
  splitLocalInput,
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

describe("time strings", () => {
  it("keeps any minute, not just the quarters", () => {
    expect(splitLocalInput("2026-09-12T14:18")).toEqual({
      date: "2026-09-12",
      time: "14:18",
    });
    expect(joinLocalInput("2026-09-12", "14:18")).toBe("2026-09-12T14:18");
  });

  it("drops seconds a browser may append", () => {
    expect(splitLocalInput("2026-09-12T14:18:30").time).toBe("14:18");
  });

  it("has no value without a date — a time alone is not a moment", () => {
    expect(joinLocalInput("", "14:18")).toBe("");
  });
});
