import { describe, it, expect } from "vitest";
import { formatDuration, formatMoney } from "./format.ts";

describe("formatMoney", () => {
  it("formats whole and fractional cents", () => {
    expect(formatMoney(12345)).toBe("$123.45");
    expect(formatMoney(5)).toBe("$0.05");
  });

  it("formats zero", () => {
    expect(formatMoney(0)).toBe("$0.00");
  });

  it("formats negatives (refunds/adjustments)", () => {
    expect(formatMoney(-500)).toBe("-$5.00");
  });
});

describe("formatDuration", () => {
  it("states both halves when both are there", () => {
    expect(formatDuration(200)).toBe("3h 20m");
  });

  it("drops the half that is zero", () => {
    expect(formatDuration(180)).toBe("3h");
    expect(formatDuration(45)).toBe("45m");
  });

  it("renders nothing for a zero-length span", () => {
    expect(formatDuration(0)).toBe("");
  });
});
