/** User-scoped data access for `expenses`. Same contract as ClientsRepo. */
import { and, desc, eq } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { expenses } from "../db/schema.ts";
import type { UpsertResult, WriteStamps } from "./clients.ts";

export type ExpenseRecord = typeof expenses.$inferSelect;

export interface ExpenseData {
  gigId: string | null;
  amountCents: number;
  category: string | null;
  receiptR2Key: string | null;
  notes: string | null;
}

export class ExpensesRepo {
  constructor(private readonly db: DrizzleD1Database) {}

  static for(d1: D1Database): ExpensesRepo {
    return new ExpensesRepo(drizzle(d1));
  }

  async list(userId: string): Promise<ExpenseRecord[]> {
    return this.db
      .select()
      .from(expenses)
      .where(eq(expenses.userId, userId))
      .orderBy(desc(expenses.createdAt));
  }

  async get(userId: string, id: string): Promise<ExpenseRecord | null> {
    const rows = await this.db
      .select()
      .from(expenses)
      .where(and(eq(expenses.id, id), eq(expenses.userId, userId)));
    return rows[0] ?? null;
  }

  async upsert(
    userId: string,
    id: string,
    data: ExpenseData,
    stamps: WriteStamps,
  ): Promise<UpsertResult<ExpenseRecord>> {
    const modifiedAt = stamps.modifiedAt ?? stamps.now;
    const existingRows = await this.db
      .select()
      .from(expenses)
      .where(eq(expenses.id, id));
    const existing = existingRows[0];

    if (existing !== undefined && existing.userId !== userId) {
      return "forbidden";
    }

    if (existing !== undefined) {
      const updated = await this.db
        .update(expenses)
        .set({ ...data, modifiedAt })
        .where(and(eq(expenses.id, id), eq(expenses.userId, userId)))
        .returning();
      return { record: updated[0]!, created: false };
    }

    const inserted = await this.db
      .insert(expenses)
      .values({ id, userId, ...data, createdAt: stamps.now, modifiedAt })
      .returning();
    return { record: inserted[0]!, created: true };
  }

  async remove(userId: string, id: string): Promise<boolean> {
    const deleted = await this.db
      .delete(expenses)
      .where(and(eq(expenses.id, id), eq(expenses.userId, userId)))
      .returning({ id: expenses.id });
    return deleted.length > 0;
  }
}
