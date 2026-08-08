/**
 * API record shapes — mirror the backend's Drizzle $inferSelect
 * types (backend/src/db/schema.ts). Cents integers, epoch-ms
 * timestamps, client-generated UUID ids.
 */
export type GigStatus = "lead" | "confirmed" | "completed" | "paid";
export const GIG_STATUSES: GigStatus[] = ["lead", "confirmed", "completed", "paid"];

export interface Gig {
  id: string;
  clientId: string | null;
  status: GigStatus;
  location: string | null;
  dateTime: number | null;
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
  status?: GigStatus;
  location?: string | null;
  dateTime?: number | null;
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
  createdAt: number;
  modifiedAt: number;
}

export interface ExpenseInput {
  gigId?: string | null;
  amountCents: number;
  category?: string | null;
  notes?: string | null;
}

export interface SessionUser {
  id: string;
  email: string;
}

export interface ReportSummary {
  totals: {
    offeredCents: number;
    paidCents: number;
    varianceCents: number;
    expensesCents: number;
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
