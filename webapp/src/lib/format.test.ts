import { describe, it, expect } from "vitest";
import { formatMoney } from "./format.ts";

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
