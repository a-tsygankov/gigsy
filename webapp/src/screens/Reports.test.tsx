/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { invoiceHref } from "./Reports.tsx";

describe("invoiceHref", () => {
  it("carries the client and the number", () => {
    expect(invoiceHref("c1", 7, {})).toBe("/reports/invoice?client=c1&n=7");
  });

  it("carries the date bounds when they exist", () => {
    expect(invoiceHref("c1", 1, { from: 100, to: 200 })).toBe(
      "/reports/invoice?client=c1&n=1&from=100&to=200",
    );
  });

  it("omits bounds that are not set, rather than sending empty ones", () => {
    // `?from=` would parse to NaN on the other side and silently drop
    // every dated gig.
    expect(invoiceHref("c1", 1, { from: 100 })).toBe(
      "/reports/invoice?client=c1&n=1&from=100",
    );
  });

  it("escapes a client id rather than trusting it in a query string", () => {
    expect(invoiceHref("a b&c", 1, {})).toBe("/reports/invoice?client=a+b%26c&n=1");
  });
});
