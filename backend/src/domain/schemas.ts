/**
 * Input validation for the user-facing API (docs/plan.md §5).
 * IDs are client-generated UUIDs (offline idempotency), money is
 * integer cents, timestamps are epoch ms. These schemas are shared by
 * the CRUD routes and the /api/sync batch endpoint.
 */
import { z } from "zod";
import { GIG_STATUSES } from "../db/schema.ts";
import { PAY_TYPES } from "./gig-pay.ts";

export const entityId = z.string().uuid();

// Money is always strictly positive when present — a zero or negative
// payment/expense/offer is a data-entry mistake, and "no amount" is
// expressed as null, never 0 (user requirement 2026-08-08).
const positiveCents = z.number().int().positive();

export const ClientInput = z.object({
  name: z.string().min(1).max(200),
  contactInfo: z.string().max(1000).nullish(),
  notes: z.string().max(4000).nullish(),
});
export type ClientInputT = z.infer<typeof ClientInput>;

export const GIG_SOURCES = ["manual", "email", "photo"] as const;

// calendarEventId deliberately absent — server-owned calendar-sync
// bookkeeping (like payments.confirmationR2Key); a client-supplied
// value would wipe/forge the Google event link. amountPaidCents is
// absent for the same reason as of Phase 4 (payment allocations):
// gigs.amountPaidCents is now the sum of payment_allocations rows for
// the gig, recomputed by services/paid-totals.ts on every allocation
// write. A client-supplied figure would be a number nobody derived
// sitting in the one field every "how much has this gig been paid"
// read trusts — GigsRepo.upsert has no such key to write, so a
// payload that still sends one (routes/gigs.ts, services/sync.ts's
// "gig" case) simply has it stripped at validation, same as
// calendarEventId.
export const GigInput = z
  .object({
    clientId: entityId.nullish(),
    title: z.string().max(200).nullish(),
    status: z.enum(GIG_STATUSES).default("lead"),
    location: z.string().max(500).nullish(),
    dateTime: z.number().int().nullish(),
    // A length in minutes. Positive when present — a zero-length gig is
    // a data-entry mistake, and "unknown" is null. Capped at 24h.
    durationMinutes: z.number().int().positive().max(24 * 60).nullish(),
    /** 'fixed' keeps amountOfferedCents as the fee; 'hourly' makes it
     *  an optional override of rate × time. Defaults to fixed so a
     *  payload written before this existed still means what it did. */
    payType: z.enum(PAY_TYPES).default("fixed"),
    hourlyRateCents: positiveCents.nullish(),
    amountOfferedCents: positiveCents.nullish(),
    // What actually happened. Epoch ms, like every other timestamp.
    workStartedAt: z.number().int().nullish(),
    workEndedAt: z.number().int().nullish(),
    /** Total time not worked inside the span. Zero is meaningful here
     *  (an explicit "no break"), so this is min(0), not positive. */
    breakMinutes: z.number().int().min(0).max(24 * 60).nullish(),
    notes: z.string().max(4000).nullish(),
    source: z.enum(GIG_SOURCES).default("manual"),
  })
  .superRefine((v, ctx) => {
    if (v.payType === "hourly" && v.hourlyRateCents == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["hourlyRateCents"],
        message: "an hourly gig needs a rate",
      });
    }
    // A start alone is the legal in-progress state. An END alone is
    // not: it would price a shift of unknown length.
    if (v.workEndedAt != null && v.workStartedAt == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["workStartedAt"],
        message: "work cannot end without having started",
      });
    }
    if (v.workStartedAt != null && v.workEndedAt != null) {
      if (v.workEndedAt <= v.workStartedAt) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["workEndedAt"],
          message: "work must end after it starts",
        });
      } else if (
        v.breakMinutes != null &&
        v.breakMinutes * 60_000 >= v.workEndedAt - v.workStartedAt
      ) {
        // Equal is rejected too: a break filling the whole shift means
        // no work happened, which is a cancelled gig, not a zero-paid
        // one.
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["breakMinutes"],
          message: "the break cannot fill the whole shift",
        });
      }
    }
  });
export type GigInputT = z.infer<typeof GigInput>;

export const ServiceInput = z.object({
  gigId: entityId,
  description: z.string().min(1).max(1000),
  amountOfferedCents: positiveCents.nullish(),
  amountPaidCents: positiveCents.nullish(),
  paymentId: entityId.nullish(),
  isCompleted: z.boolean().default(false),
});
export type ServiceInputT = z.infer<typeof ServiceInput>;

// confirmationR2Key deliberately absent — set only by the upload
// endpoint (server-controlled keys).
export const PaymentInput = z.object({
  gigId: entityId.nullish(),
  // Which client this transfer came from (migration 0016). Nullable —
  // a payment recorded before you know who sent it is still worth
  // recording — but once set, routes/allocations.ts restricts the
  // payment's split to that client's gigs.
  clientId: entityId.nullish(),
  amountCents: positiveCents,
  paidAt: z.number().int().nullish(),
  notes: z.string().max(4000).nullish(),
});
export type PaymentInputT = z.infer<typeof PaymentInput>;

// Which gig a payment's money went to, and how much. paymentId and
// gigId are both required — an allocation is meaningless without
// either end of the link it makes, unlike PaymentInput.gigId which is
// nullish because a payment can exist before it's tied to any gig.
export const AllocationInput = z.object({
  paymentId: entityId,
  gigId: entityId,
  // Positive like every other amount: a zero allocation is a deleted
  // allocation with extra steps.
  amountCents: positiveCents,
});
export type AllocationInputT = z.infer<typeof AllocationInput>;

export const ExpenseInput = z.object({
  gigId: entityId.nullish(),
  amountCents: positiveCents,
  category: z.string().max(100).nullish(),
  receiptR2Key: z.string().max(500).nullish(),
  notes: z.string().max(4000).nullish(),
  // "The client should cover this." Defaults false so existing
  // payloads keep their meaning.
  reimbursable: z.boolean().default(false),
});
export type ExpenseInputT = z.infer<typeof ExpenseInput>;
