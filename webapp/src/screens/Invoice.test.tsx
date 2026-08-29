/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { invoiceParams, unpricedNotice } from "./Invoice.tsx";

describe("invoiceParams", () => {
  it("reads the client, the number, the issue date and the bounds", () => {
    expect(
      invoiceParams(new URLSearchParams("client=c1&n=7&issued=1000&from=100&to=200")),
    ).toEqual({
      clientId: "c1",
      number: 7,
      issuedAt: 1000,
      filters: { from: 100, to: 200 },
    });
  });

  it("leaves bounds out when they are absent", () => {
    expect(invoiceParams(new URLSearchParams("client=c1&n=7&issued=1000"))).toEqual({
      clientId: "c1",
      number: 7,
      issuedAt: 1000,
      filters: {},
    });
  });

  it("names the gigs it could not price, so nobody under-bills in silence", () => {
    // Not a nicety: `buildInvoice` drops work whose price is unknown
    // rather than billing zero, and this banner is the only place that
    // fact surfaces before the document is sent.
    expect(
      unpricedNotice({ unpricedGigs: [{ id: "g1", description: "Tasting" }] }),
    ).toBe("1 completed gig has no price set, so it is not on this invoice:");
    expect(
      unpricedNotice({
        unpricedGigs: [
          { id: "g1", description: "Tasting" },
          { id: "g2", description: "Promo" },
        ],
      }),
    ).toBe("2 completed gigs have no price set, so they are not on this invoice:");
  });

  it("refuses a missing client rather than inventing one", () => {
    expect(invoiceParams(new URLSearchParams("n=7&issued=1000"))).toBeNull();
  });

  it("refuses a number that is not a positive integer", () => {
    // A hand-edited URL must not print "INV-NaN" on a document that
    // gets sent to somebody.
    expect(invoiceParams(new URLSearchParams("client=c1&n=x&issued=1000"))).toBeNull();
    expect(invoiceParams(new URLSearchParams("client=c1&n=0&issued=1000"))).toBeNull();
    expect(invoiceParams(new URLSearchParams("client=c1&issued=1000"))).toBeNull();
  });

  it("refuses an issue date that is not a positive integer", () => {
    // Same reasoning as the number check: a document printing "Invalid
    // Date" is worse than a link that admits it is broken. The issue
    // date fixes the document to the link (Task 4 stamps it once, at
    // allocation), so a missing or nonsense one is refused the same way.
    expect(invoiceParams(new URLSearchParams("client=c1&n=1"))).toBeNull();
    expect(invoiceParams(new URLSearchParams("client=c1&n=1&issued=x"))).toBeNull();
    expect(invoiceParams(new URLSearchParams("client=c1&n=1&issued=0"))).toBeNull();
    expect(invoiceParams(new URLSearchParams("client=c1&n=1&issued=-5"))).toBeNull();
  });

  it("ignores a bound that is not a number", () => {
    expect(invoiceParams(new URLSearchParams("client=c1&n=1&issued=1000&from=x"))).toEqual({
      clientId: "c1",
      number: 1,
      issuedAt: 1000,
      filters: {},
    });
  });
});
