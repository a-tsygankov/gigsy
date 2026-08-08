import { describe, it, expect } from "vitest";
import { centsToInput, parseMoney } from "./money.ts";

describe("parseMoney (dollars string → integer cents)", () => {
  it("parses whole dollars", () => {
    expect(parseMoney("123")).toBe(12300);
  });

  it("parses one and two decimal places", () => {
    expect(parseMoney("123.4")).toBe(12340);
    expect(parseMoney("123.45")).toBe(12345);
  });

  it("strips $ and thousands separators and whitespace", () => {
    expect(parseMoney(" $1,234.56 ")).toBe(123456);
  });

  it("accepts negatives (refunds/adjustments)", () => {
    expect(parseMoney("-5")).toBe(-500);
  });

  it("rejects junk, empties, and >2 decimals", () => {
    expect(parseMoney("")).toBeNull();
    expect(parseMoney("abc")).toBeNull();
    expect(parseMoney("1.234")).toBeNull();
    expect(parseMoney("1.2.3")).toBeNull();
  });
});

describe("centsToInput (integer cents → editable dollars string)", () => {
  it("renders two decimals, no currency symbol", () => {
    expect(centsToInput(12345)).toBe("123.45");
    expect(centsToInput(500)).toBe("5.00");
  });

  it("round-trips with parseMoney", () => {
    expect(parseMoney(centsToInput(98765))).toBe(98765);
  });
});
