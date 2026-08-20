/** User-scoped data access for `payments`. Same contract as the other
 * repos; confirmationR2Key is preserved on upsert (server-owned field
 * updated only via setConfirmationKey). */
import { and, desc, eq } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { payments } from "../db/schema.ts";
import type { UpsertResult, WriteStamps } from "./clients.ts";

export type PaymentRecord = typeof payments.$inferSelect;

export interface PaymentData {
  gigId: string | null;
  clientId: string | null;
  amountCents: number;
  paidAt: number | null;
  notes: string | null;
}

export class PaymentsRepo {
  constructor(private readonly db: DrizzleD1Database) {}

  static for(d1: D1Database): PaymentsRepo {
    return new PaymentsRepo(drizzle(d1));
  }

  async list(userId: string): Promise<PaymentRecord[]> {
    return this.db
      .select()
      .from(payments)
      .where(eq(payments.userId, userId))
      .orderBy(desc(payments.createdAt));
  }

  async get(userId: string, id: string): Promise<PaymentRecord | null> {
    const rows = await this.db
      .select()
      .from(payments)
      .where(and(eq(payments.id, id), eq(payments.userId, userId)));
    return rows[0] ?? null;
  }

  async upsert(
    userId: string,
    id: string,
    data: PaymentData,
    stamps: WriteStamps,
  ): Promise<UpsertResult<PaymentRecord>> {
    const modifiedAt = stamps.modifiedAt ?? stamps.now;
    const existingRows = await this.db
      .select()
      .from(payments)
      .where(eq(payments.id, id));
    const existing = existingRows[0];

    if (existing !== undefined && existing.userId !== userId) {
      return "forbidden";
    }

    if (existing !== undefined) {
      const updated = await this.db
        .update(payments)
        .set({ ...data, modifiedAt })
        .where(and(eq(payments.id, id), eq(payments.userId, userId)))
        .returning();
      return { record: updated[0]!, created: false };
    }

    const inserted = await this.db
      .insert(payments)
      .values({ id, userId, ...data, createdAt: stamps.now, modifiedAt })
      .returning();
    return { record: inserted[0]!, created: true };
  }

  /** Server-owned: only the confirmation upload endpoint calls this. */
  async setConfirmationKey(
    userId: string,
    id: string,
    r2Key: string,
    now: number,
  ): Promise<boolean> {
    const updated = await this.db
      .update(payments)
      .set({ confirmationR2Key: r2Key, modifiedAt: now })
      .where(and(eq(payments.id, id), eq(payments.userId, userId)))
      .returning({ id: payments.id });
    return updated.length > 0;
  }

  async remove(userId: string, id: string): Promise<boolean> {
    const deleted = await this.db
      .delete(payments)
      .where(and(eq(payments.id, id), eq(payments.userId, userId)))
      .returning({ id: payments.id });
    return deleted.length > 0;
  }
}
