/**
 * The same vectors the backend runs (backend/test/gig-pay.test.ts).
 *
 * This file existing twice is the point: the module is duplicated
 * because the PWA prices gigs offline and the worker prices them for
 * reports, and the fixture is what stops the two copies drifting.
 */
import { describe, it, expect } from "vitest";
import vectors from "../../../fixtures/gig-pay-vectors.json";
import {
  billableMinutes,
  expectedCents,
  isPaid,
  outstandingCents,
  PAY_TYPES,
  storedOrDerivedExpectedCents,
  workedMinutes,
  type PayableGig,
  type PaidGig,
} from "./gig-pay.ts";

describe("gig pay vectors", () => {
  for (const c of vectors.cases) {
    it(c.name, () => {
      const gig = c.gig as PayableGig;
      // That cast narrows a plain JSON string to the PayType union, so
      // nothing else would catch a typo in the fixture: expectedCents
      // special-cases "fixed" and treats everything else as hourly, so
      // a stray "Hourly" would price as an hourly gig and pass.
      expect(PAY_TYPES).toContain(gig.payType);
      expect(workedMinutes(gig)).toBe(c.workedMinutes);
      expect(billableMinutes(gig)).toBe(c.billableMinutes);
      expect(expectedCents(gig)).toBe(c.expectedCents);
    });
  }
});

describe("paid vectors", () => {
  for (const c of vectors.paidCases) {
    it(c.name, () => {
      const gig = c.gig as PaidGig;
      expect(outstandingCents(gig)).toBe(c.outstandingCents);
      expect(isPaid(gig)).toBe(c.isPaid);
    });
  }
});

/**
 * The display fallback. `expectedCents` is a server-owned column that
 * a gig only has once it has synced, so the screens read it through
 * this and derive locally until then.
 */
describe("storedOrDerivedExpectedCents", () => {
  const hourly: PayableGig = {
    payType: "hourly",
    hourlyRateCents: 5000,
    amountOfferedCents: null,
    durationMinutes: 480,
    workStartedAt: null,
    workEndedAt: null,
    breakMinutes: null,
  };

  it("prefers what the server stored", () => {
    // Deliberately NOT 40000: if the two ever disagree, the figure the
    // aggregates are built from is the one to show.
    expect(storedOrDerivedExpectedCents({ ...hourly, expectedCents: 12345 })).toBe(
      12345,
    );
  });

  it("derives locally for a gig that has not synced yet", () => {
    expect(storedOrDerivedExpectedCents({ ...hourly, expectedCents: null })).toBe(
      40000,
    );
  });

  it("still reports nothing when there is nothing to say", () => {
    // Null is not zero — an hourly gig with no time to bill on has an
    // unknown value, and $0.00 would read as work that pays nothing.
    expect(
      storedOrDerivedExpectedCents({
        ...hourly,
        durationMinutes: null,
        expectedCents: null,
      }),
    ).toBeNull();
  });

  it("agrees with the local derivation across every shared vector", () => {
    for (const c of vectors.cases) {
      const gig = c.gig as PayableGig;
      expect(storedOrDerivedExpectedCents({ ...gig, expectedCents: null })).toBe(
        c.expectedCents,
      );
    }
  });
});
