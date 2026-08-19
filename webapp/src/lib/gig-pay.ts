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
 * DUPLICATED from backend/src/domain/gig-pay.ts as far as
 * `expectedCents`. Both copies are pinned by
 * fixtures/gig-pay-vectors.json; change them together.
 *
 * `storedOrDerivedExpectedCents` is webapp-only and has no backend
 * counterpart; see its own comment. `outstandingCents`/`isPaid` DO
 * exist in both files and share the same vectors, but are no longer
 * byte-identical below this header: this copy routes through
 * `storedOrDerivedExpectedCents`, the backend copy calls
 * `expectedCents()` directly. That is deliberate, not drift — see the
 * comment on `outstandingCents` below for why.
 *
 * One claim in the body below is true only of the backend copy, and is
 * left as-is here rather than edited, because editing it would make the
 * two copies diverge: the comment above the rounding step in
 * `expectedCents` says a negative `hourlyRateCents` "cannot be stored"
 * because the write schema types it `positiveCents` (domain/schemas.ts).
 * That schema is the backend's validated write path. This copy runs
 * against raw draft form state on every keystroke (GigEdit.tsx's
 * `draftPay`), before OfflineDataService.assertPositive (data-service.ts)
 * or the backend ever see it — so here, unlike in the backend, a zero or
 * negative rate can and does reach `expectedCents` while the user is
 * still typing. `Math.round` still returns a signed result for it; that
 * is fine for a live preview, and GigEdit itself now refuses to submit
 * such a rate (see the guard in `submit()`).
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

/**
 * The figure to SHOW for a stored gig. Not part of the mirrored core
 * above — the backend has no counterpart, because there the column is
 * the answer.
 *
 * `expectedCents` is a server-owned derived column (migration 0014):
 * GigsRepo.upsert recomputes it from this same formula on every write,
 * and every money total on the server sums it. Preferring it here is
 * what stops a gig row disagreeing with the dashboard it feeds.
 *
 * The fallback is not belt-and-braces. EVERY local save writes
 * `expectedCents: null` and queues the gig in the outbox
 * (lib/local-store.ts), deliberately: the field means "what the server
 * said", and the edit has just invalidated that. So without the
 * fallback a gig would show no amount at all from the moment it is
 * saved until a pull brings the server's answer back — which, offline,
 * may be days. Both copies compute the same thing, so the stored value
 * and the derived one cannot disagree.
 */
export function storedOrDerivedExpectedCents(
  gig: PayableGig & { expectedCents: number | null },
): number | null {
  return gig.expectedCents ?? expectedCents(gig);
}

/**
 * A gig plus what has landed against it. Also mirrored from the
 * backend copy of this file, with one deliberate divergence — see
 * `outstandingCents` below.
 */
export interface PaidGig extends PayableGig {
  amountPaidCents: number | null;
  expectedCents: number | null;
}

/**
 * What is still owed, or null when the expectation is unknown.
 *
 * Never negative: overpayment is a bookkeeping curiosity, not a debt
 * the app owes back, and a negative here would subtract from the
 * dashboard's outstanding total and hide a real unpaid gig.
 *
 * DIVERGES from the backend copy here: this goes through
 * `storedOrDerivedExpectedCents`, not `expectedCents()` directly. On
 * the server the `expectedCents` column is always current (GigsRepo.upsert
 * recomputes it on every write), so calling `expectedCents()` there is
 * exact. Offline, a gig can be mid-edit with no synced column yet —
 * calling `expectedCents()` directly here would let a gig row and the
 * dashboard it feeds land on two different figures for the same gig,
 * which is exactly what `storedOrDerivedExpectedCents` exists to
 * prevent (see its comment above).
 */
export function outstandingCents(gig: PaidGig): number | null {
  const expected = storedOrDerivedExpectedCents(gig);
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
