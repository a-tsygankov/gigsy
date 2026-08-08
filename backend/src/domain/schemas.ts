/**
 * Input validation for the user-facing API (docs/plan.md §5).
 * IDs are client-generated UUIDs (offline idempotency), money is
 * integer cents, timestamps are epoch ms. These schemas are shared by
 * the CRUD routes and the /api/sync batch endpoint.
 */
import { z } from "zod";
import { GIG_STATUSES } from "../db/schema.ts";

export const entityId = z.string().uuid();

export const ClientInput = z.object({
  name: z.string().min(1).max(200),
  contactInfo: z.string().max(1000).nullish(),
  notes: z.string().max(4000).nullish(),
});
export type ClientInputT = z.infer<typeof ClientInput>;

export const GIG_SOURCES = ["manual", "email", "photo"] as const;

export const GigInput = z.object({
  clientId: entityId.nullish(),
  status: z.enum(GIG_STATUSES).default("lead"),
  location: z.string().max(500).nullish(),
  dateTime: z.number().int().nullish(),
  calendarEventId: z.string().max(200).nullish(),
  amountOfferedCents: z.number().int().nullish(),
  amountPaidCents: z.number().int().nullish(),
  notes: z.string().max(4000).nullish(),
  source: z.enum(GIG_SOURCES).default("manual"),
});
export type GigInputT = z.infer<typeof GigInput>;

export const ServiceInput = z.object({
  gigId: entityId,
  description: z.string().min(1).max(1000),
  amountOfferedCents: z.number().int().nullish(),
  amountPaidCents: z.number().int().nullish(),
  paymentId: entityId.nullish(),
  isCompleted: z.boolean().default(false),
});
export type ServiceInputT = z.infer<typeof ServiceInput>;

// confirmationR2Key deliberately absent — set only by the upload
// endpoint (server-controlled keys).
export const PaymentInput = z.object({
  gigId: entityId.nullish(),
  amountCents: z.number().int(),
  paidAt: z.number().int().nullish(),
  notes: z.string().max(4000).nullish(),
});
export type PaymentInputT = z.infer<typeof PaymentInput>;

export const ExpenseInput = z.object({
  gigId: entityId.nullish(),
  amountCents: z.number().int(),
  category: z.string().max(100).nullish(),
  receiptR2Key: z.string().max(500).nullish(),
  notes: z.string().max(4000).nullish(),
});
export type ExpenseInputT = z.infer<typeof ExpenseInput>;
