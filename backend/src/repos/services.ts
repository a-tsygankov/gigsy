/** User-scoped data access for `gig_services`. Same contract as the
 * other repos. */
import { and, desc, eq } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { gigServices } from "../db/schema.ts";
import type { UpsertResult, WriteStamps } from "./clients.ts";

export type ServiceRecord = typeof gigServices.$inferSelect;

export interface ServiceData {
  gigId: string;
  description: string;
  amountOfferedCents: number | null;
  amountPaidCents: number | null;
  paymentId: string | null;
  isCompleted: boolean;
}

export class ServicesRepo {
  constructor(private readonly db: DrizzleD1Database) {}

  static for(d1: D1Database): ServicesRepo {
    return new ServicesRepo(drizzle(d1));
  }

  async list(userId: string): Promise<ServiceRecord[]> {
    return this.db
      .select()
      .from(gigServices)
      .where(eq(gigServices.userId, userId))
      .orderBy(desc(gigServices.createdAt));
  }

  async get(userId: string, id: string): Promise<ServiceRecord | null> {
    const rows = await this.db
      .select()
      .from(gigServices)
      .where(and(eq(gigServices.id, id), eq(gigServices.userId, userId)));
    return rows[0] ?? null;
  }

  async upsert(
    userId: string,
    id: string,
    data: ServiceData,
    stamps: WriteStamps,
  ): Promise<UpsertResult<ServiceRecord>> {
    const modifiedAt = stamps.modifiedAt ?? stamps.now;
    const existingRows = await this.db
      .select()
      .from(gigServices)
      .where(eq(gigServices.id, id));
    const existing = existingRows[0];

    if (existing !== undefined && existing.userId !== userId) {
      return "forbidden";
    }

    if (existing !== undefined) {
      const updated = await this.db
        .update(gigServices)
        .set({ ...data, modifiedAt })
        .where(and(eq(gigServices.id, id), eq(gigServices.userId, userId)))
        .returning();
      return { record: updated[0]!, created: false };
    }

    const inserted = await this.db
      .insert(gigServices)
      .values({ id, userId, ...data, createdAt: stamps.now, modifiedAt })
      .returning();
    return { record: inserted[0]!, created: true };
  }

  async remove(userId: string, id: string): Promise<boolean> {
    const deleted = await this.db
      .delete(gigServices)
      .where(and(eq(gigServices.id, id), eq(gigServices.userId, userId)))
      .returning({ id: gigServices.id });
    return deleted.length > 0;
  }
}
