/**
 * API record shapes — mirror the backend's Drizzle $inferSelect
 * types (backend/src/db/schema.ts). Cents integers, epoch-ms
 * timestamps, client-generated UUID ids.
 */
import { PAY_TYPES, type PayType } from "./gig-pay.ts";

export type GigStatus = "lead" | "confirmed" | "completed" | "cancelled";
export const GIG_STATUSES: GigStatus[] = ["lead", "confirmed", "completed", "cancelled"];

// Re-exported so screens have one import site for the pay vocabulary.
export type { PayType };
export { PAY_TYPES };

export interface Gig {
  id: string;
  clientId: string | null;
  /** Optional name; the UI falls back to the first line of notes. */
  title: string | null;
  status: GigStatus;
  location: string | null;
  dateTime: number | null;
  /** How long the gig runs; the calendar uses it instead of guessing. */
  durationMinutes: number | null;
  /** 'fixed' — amountOfferedCents is the fee. 'hourly' — it is an
   *  optional override of rate × time (lib/gig-pay.ts). */
  payType: PayType;
  hourlyRateCents: number | null;
  /** What actually happened, as opposed to dateTime/durationMinutes,
   *  which are what was agreed. Only pay reads these. */
  workStartedAt: number | null;
  workEndedAt: number | null;
  breakMinutes: number | null;
  calendarEventId: string | null;
  amountOfferedCents: number | null;
  amountPaidCents: number | null;
  /**
   * What the SERVER says this gig is expected to earn — its offer when
   * fixed, rate × time when hourly. Server-owned and derived: it has no
   * counterpart in GigInput, the outbox never sends it, and it is what
   * every backend money total sums (migration 0014).
   *
   * Null on a gig that has not been through the server yet, which is
   * why the screens read it through `storedOrDerivedExpectedCents`
   * (lib/gig-pay.ts) rather than directly.
   *
   * `number | null` overstates it for one case: rows already in Dexie
   * from before this release hold `undefined`, and no Dexie upgrade
   * backfills them — they gain the field when the next pull rewrites
   * the record. The type is safe only because every reader goes
   * through that helper, whose `??` treats undefined and null alike.
   * Anything that ever compares this field with `=== null` has to
   * handle undefined itself.
   */
  expectedCents: number | null;
  notes: string | null;
  source: string | null;
  createdAt: number;
  modifiedAt: number;
}

export interface GigInput {
  clientId?: string | null;
  title?: string | null;
  status?: GigStatus;
  location?: string | null;
  dateTime?: number | null;
  durationMinutes?: number | null;
  payType?: PayType;
  hourlyRateCents?: number | null;
  workStartedAt?: number | null;
  workEndedAt?: number | null;
  breakMinutes?: number | null;
  amountOfferedCents?: number | null;
  amountPaidCents?: number | null;
  notes?: string | null;
  source?: "manual" | "email" | "photo";
}

export interface Client {
  id: string;
  name: string;
  contactInfo: string | null;
  notes: string | null;
  createdAt: number;
  modifiedAt: number;
}

export interface ClientInput {
  name: string;
  contactInfo?: string | null;
  notes?: string | null;
}

export interface Expense {
  id: string;
  gigId: string | null;
  amountCents: number;
  category: string | null;
  receiptR2Key: string | null;
  notes: string | null;
  /** The client is expected to cover this cost. */
  reimbursable: boolean;
  createdAt: number;
  modifiedAt: number;
}

export interface ExpenseInput {
  gigId?: string | null;
  amountCents: number;
  category?: string | null;
  notes?: string | null;
  reimbursable?: boolean;
}

// Additional services on a gig (client link derives through the gig).
export interface Service {
  id: string;
  gigId: string;
  description: string;
  amountOfferedCents: number | null;
  amountPaidCents: number | null;
  paymentId: string | null;
  isCompleted: boolean;
  createdAt: number;
  modifiedAt: number;
}

export interface ServiceInput {
  gigId: string;
  description: string;
  amountOfferedCents?: number | null;
  amountPaidCents?: number | null;
  paymentId?: string | null;
  isCompleted?: boolean;
}

// Money-received records; confirmationR2Key is server-owned (set by
// the upload endpoint only).
export interface Payment {
  id: string;
  /**
   * LEGACY, and on its way out (migration 0016, phase-4 plan Task 1).
   * What a payment paid for is an `Allocation` now — possibly several,
   * possibly covering only part of the payment, neither of which this
   * one nullable column can say.
   *
   * The server still stores it and still translates a non-null one
   * into a single allocation (`AllocationsRepo.replaceSoleAllocation`),
   * for the builds that were queued or installed before allocations
   * existed. THIS build no longer sends it — see `putPayment` in
   * lib/local-store.ts for why sending it would destroy a partial
   * split — so the column empties out as records are re-saved, and the
   * screens read it through `LocalStore`'s allocation-backed view
   * rather than off the wire.
   */
  gigId: string | null;
  amountCents: number;
  paidAt: number | null;
  confirmationR2Key: string | null;
  notes: string | null;
  createdAt: number;
  modifiedAt: number;
}

export interface PaymentInput {
  /** Accepted from callers (the payment screen still asks for one gig
   *  until Task 7 replaces it with a split editor) and turned into the
   *  payment's sole allocation locally. It is deliberately NOT part of
   *  the outbox payload — lib/local-store.ts's `putPayment`. */
  gigId?: string | null;
  amountCents: number;
  paidAt?: number | null;
  notes?: string | null;
}

/**
 * How much of one payment paid for one gig — the sixth sync entity
 * (migration 0016). A payment may have several, and they may sum to
 * LESS than the payment: an unallocated remainder is a legitimate,
 * visible state (a transfer can land before you know what it covers),
 * which is exactly why `Payment.gigId` could not express this.
 *
 * Over-allocation is not legitimate and the server rejects it
 * ("allocations exceed the payment").
 */
export interface Allocation {
  id: string;
  paymentId: string;
  gigId: string;
  amountCents: number;
  createdAt: number;
  modifiedAt: number;
}

/** Both ends are required — an allocation is the link itself, and a
 *  link missing an end is nothing (backend AllocationInput says the
 *  same). */
export interface AllocationInput {
  paymentId: string;
  gigId: string;
  amountCents: number;
}

export interface UnpaidJob {
  gigId: string;
  clientId: string | null;
  clientName: string | null;
  dateTime: number | null;
  offeredCents: number;
  paidCents: number;
  servicesOfferedCents: number;
  servicesPaidCents: number;
  outstandingCents: number;
}

export interface DashboardSummary {
  completedCount: number;
  expectedCents: number;
  unpaidCents: number;
  unpaidJobs: UnpaidJob[];
}

// AI-capture drafts (review gate — server records, docs/plan.md §8).
export interface DraftExtracted {
  // "payment" (Phase 4): a receipt/slip proving the user was PAID, as
  // opposed to "expense" (the user paid). Mirrors backend/src/capture/
  // extraction.ts's ExtractedData exactly — this type only exists so
  // the review screen can read what the server already validated.
  kind: "gig" | "expense" | "payment" | "unknown";
  clientName?: string | null;
  matchedClientId?: string | null;
  matchConfidence?: number | null;
  location?: string | null;
  // Doubles as a payment's received date — see extraction.ts's comment
  // on the same field for why there is no separate paidAtMs.
  dateTimeMs?: number | null;
  amountOfferedCents?: number | null;
  amountCents?: number | null;
  category?: string | null;
  notes?: string | null;
}

export interface Draft {
  id: string;
  source: "email" | "photo";
  status: "pending" | "confirmed" | "discarded";
  rawR2Key: string | null;
  extracted: DraftExtracted;
  createdAt: number;
  modifiedAt: number;
}

export interface SessionUser {
  id: string;
  email: string;
}

/** Report scoping (docs/plan.md §10). Mirrors the endpoint's query
 * params: an absent field means "unfiltered". */
export interface ReportFilters {
  from?: number;
  to?: number;
  clientId?: string;
}

export interface ReportSummary {
  totals: {
    offeredCents: number;
    paidCents: number;
    owedCents: number;
    expensesCents: number;
    /** Portion of expensesCents the client should cover. Reported
     * beside net, never removed from it. */
    reimbursableCents: number;
    netCents: number;
  };
  byMonth: {
    month: string;
    offeredCents: number;
    paidCents: number;
    expensesCents: number;
    netCents: number;
  }[];
  byClient: {
    clientId: string | null;
    clientName: string | null;
    offeredCents: number;
    paidCents: number;
  }[];
}
