/**
 * What a gig is expected to pay.
 *
 * Two questions a gig answers separately, and the reason its fields are
 * split the way they are:
 *
 *   - The PLAN (`dateTime`, `durationMinutes`) is what was agreed. It
 *     is what the calendar event and the availability projection are
 *     built from — see domain/gig-time.ts — and recording what actually
 *     happened must never move it.
 *   - The ACTUALS (`workStartedAt`, `workEndedAt`, `breakMinutes`) are
 *     what happened. They exist to be paid on, and for nothing else.
 *
 * So pay prefers the actuals and falls back to the plan: before the
 * shift, an hourly gig shows the quote; after it, the real figure.
 *
 * DUPLICATED in webapp/src/lib/gig-pay.ts. Both copies are pinned by
 * fixtures/gig-pay-vectors.json; change them together.
 *
 * One deliberate divergence: `outstandingCents`/`isPaid` below call
 * `expectedCents()` directly, because on the server `expectedCents` is
 * a stored column (migration 0014) that GigsRepo.upsert keeps in sync
 * with this same formula — the column IS the answer here. The webapp
 * copy instead goes through `storedOrDerivedExpectedCents`, because a
 * client-side gig can be mid-edit with no synced column yet. See that
 * function's comment in webapp/src/lib/gig-pay.ts for why.
 */

export const PAY_TYPES = ["fixed", "hourly"] as const;
export type PayType = (typeof PAY_TYPES)[number];

/** Just enough of a gig to price it. Deliberately narrow, like
 *  TimedGig in gig-time.ts. */
export interface PayableGig {
  payType: PayType;
  hourlyRateCents: number | null;
  /** On an hourly gig this is the OVERRIDE: non-null replaces the
   *  computed figure entirely, null means "compute it". */
  amountOfferedCents: number | null;
  durationMinutes: number | null;
  workStartedAt: number | null;
  workEndedAt: number | null;
  breakMinutes: number | null;
}

/**
 * Time actually worked, or null until the shift is finished.
 *
 * A started-but-not-stopped shift is null rather than "so far": a
 * number that grows while nobody is looking would put a moving figure
 * into reports, and the in-progress case is the screen's business, not
 * this module's.
 *
 * Clamped at zero. A break longer than the span is a data-entry
 * mistake, and negative worked time would propagate into a negative
 * payment.
 */
export function workedMinutes(gig: PayableGig): number | null {
  if (gig.workStartedAt === null || gig.workEndedAt === null) return null;
  const span = (gig.workEndedAt - gig.workStartedAt) / 60_000;
  return Math.max(0, Math.round(span) - (gig.breakMinutes ?? 0));
}

/** What the hourly rate multiplies: the actuals when they exist, the
 *  plan until they do. */
export function billableMinutes(gig: PayableGig): number | null {
  return workedMinutes(gig) ?? gig.durationMinutes;
}

/**
 * Expected pay in cents, or null when there is nothing to say.
 *
 * Null is not zero: an hourly gig with no rate, no duration and no work
 * logged has an UNKNOWN value, and showing $0.00 for it would read as a
 * gig that pays nothing.
 */
export function expectedCents(gig: PayableGig): number | null {
  if (gig.payType === "fixed") return gig.amountOfferedCents;
  if (gig.amountOfferedCents !== null) return gig.amountOfferedCents;
  const minutes = billableMinutes(gig);
  if (minutes === null || gig.hourlyRateCents === null) return null;
  // Half-up. Math.round is half-up for positives, and positive is all
  // this sees: the write schema types hourlyRateCents as positiveCents
  // (domain/schemas.ts), so a negative rate cannot be stored. This
  // module does not re-check it — it is a derivation, not a validator,
  // and a second opinion on the same rule is a second thing to keep in
  // step.
  return Math.round((gig.hourlyRateCents * minutes) / 60);
}

/** A gig plus what has landed against it. */
export interface PaidGig extends PayableGig {
  amountPaidCents: number | null;
}

/**
 * What is still owed, or null when the expectation is unknown.
 *
 * Never negative: overpayment is a bookkeeping curiosity, not a debt
 * the app owes back, and a negative here would subtract from the
 * dashboard's outstanding total and hide a real unpaid gig.
 */
export function outstandingCents(gig: PaidGig): number | null {
  const expected = expectedCents(gig);
  if (expected === null) return null;
  return Math.max(0, expected - (gig.amountPaidCents ?? 0));
}

/**
 * Paid when nothing is outstanding.
 *
 * An unknown expectation is NOT paid, whatever has been received: this
 * is what used to be a status someone set by hand, and the honest
 * answer to "is this settled" when we don't know what it should earn is
 * no.
 */
export function isPaid(gig: PaidGig): boolean {
  return outstandingCents(gig) === 0;
}
