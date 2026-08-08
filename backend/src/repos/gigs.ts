/** User-scoped data access for `gigs`. Same contract as ClientsRepo. */
import { and, desc, eq } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { gigs, type GigStatus } from "../db/schema.ts";
import type { UpsertResult, WriteStamps } from "./clients.ts";

export type GigRecord = typeof gigs.$inferSelect;

export interface GigData {
  clientId: string | null;
  status: GigStatus;
  location: string | null;
  dateTime: number | null;
  calendarEventId: string | null;
  amountOfferedCents: number | null;
  amountPaidCents: number | null;
  notes: string | null;
  source: string | null;
}

export class GigsRepo {
  constructor(private readonly db: DrizzleD1Database) {}

  static for(d1: D1Database): GigsRepo {
    return new GigsRepo(drizzle(d1));
  }

  async list(userId: string): Promise<GigRecord[]> {
    return this.db
      .select()
      .from(gigs)
      .where(eq(gigs.userId, userId))
      .orderBy(desc(gigs.dateTime));
  }

  async get(userId: string, id: string): Promise<GigRecord | null> {
    const rows = await this.db
      .select()
      .from(gigs)
      .where(and(eq(gigs.id, id), eq(gigs.userId, userId)));
    return rows[0] ?? null;
  }

  async upsert(
    userId: string,
    id: string,
    data: GigData,
    stamps: WriteStamps,
  ): Promise<UpsertResult<GigRecord>> {
    const modifiedAt = stamps.modifiedAt ?? stamps.now;
    const existingRows = await this.db.select().from(gigs).where(eq(gigs.id, id));
    const existing = existingRows[0];

    if (existing !== undefined && existing.userId !== userId) {
      return "forbidden";
    }

    if (existing !== undefined) {
      const updated = await this.db
        .update(gigs)
        .set({ ...data, modifiedAt })
        .where(and(eq(gigs.id, id), eq(gigs.userId, userId)))
        .returning();
      return { record: updated[0]!, created: false };
    }

    const inserted = await this.db
      .insert(gigs)
      .values({ id, userId, ...data, createdAt: stamps.now, modifiedAt })
      .returning();
    return { record: inserted[0]!, created: true };
  }

  async remove(userId: string, id: string): Promise<boolean> {
    const deleted = await this.db
      .delete(gigs)
      .where(and(eq(gigs.id, id), eq(gigs.userId, userId)))
      .returning({ id: gigs.id });
    return deleted.length > 0;
  }
}
