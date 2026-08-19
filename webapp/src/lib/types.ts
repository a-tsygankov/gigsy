/**
 * API record shapes — mirror the backend's Drizzle $inferSelect
 * types (backend/src/db/schema.ts). Cents integers, epoch-ms
 * timestamps, client-generated UUID ids.
 */
import { PAY_TYPES, type PayType } from "./gig-pay.ts";

export type GigStatus = "lead" | "confirmed" | "completed" | "paid";
export const GIG_STATUSES: GigStatus[] = ["lead", "confirmed", "completed", "paid"];

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
  gigId: string | null;
  amountCents: number;
  paidAt: number | null;
  confirmationR2Key: string | null;
  notes: string | null;
  createdAt: number;
  modifiedAt: number;
}

export interface PaymentInput {
  gigId?: string | null;
  amountCents: number;
  paidAt?: number | null;
  notes?: string | null;
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
  kind: "gig" | "expense" | "unknown";
  clientName?: string | null;
  matchedClientId?: string | null;
  matchConfidence?: number | null;
  location?: string | null;
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
