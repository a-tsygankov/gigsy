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
  PAY_TYPES,
  workedMinutes,
  type PayableGig,
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
