import { describe, it, expect } from "vitest";
import { localInputToMs, msToLocalInput } from "./datetime.ts";

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
