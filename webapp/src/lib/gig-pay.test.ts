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
  workedMinutes,
  type PayableGig,
} from "./gig-pay.ts";

describe("gig pay vectors", () => {
  for (const c of vectors.cases) {
    it(c.name, () => {
      const gig = c.gig as PayableGig;
      expect(workedMinutes(gig)).toBe(c.workedMinutes);
      expect(billableMinutes(gig)).toBe(c.billableMinutes);
      expect(expectedCents(gig)).toBe(c.expectedCents);
    });
  }
});
