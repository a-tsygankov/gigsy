/// <reference types="@cloudflare/vitest-pool-workers" />
/**
 * The pay derivation, against the shared vectors.
 *
 * `src/domain/gig-pay.ts` is duplicated in the webapp — the PWA
 * computes expected pay offline, the server computes it for reports,
 * and there is no shared package between them. These vectors are the
 * only thing standing between that duplication and two apps quietly
 * disagreeing about what a gig earned. Both suites run the same
 * fixture; a fix to one copy that is not a fix to the other fails here.
 */
import { describe, it, expect } from "vitest";
import vectors from "../../fixtures/gig-pay-vectors.json";
import {
  billableMinutes,
  expectedCents,
  isPaid,
  outstandingCents,
  PAY_TYPES,
  workedMinutes,
  type PayableGig,
  type PaidGig,
} from "../src/domain/gig-pay.ts";

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
