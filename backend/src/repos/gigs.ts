/** User-scoped data access for `gigs`. Same contract as ClientsRepo. */
import { and, desc, eq, gt } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { calendarCleanup, gigs, type GigStatus } from "../db/schema.ts";
import type { UpsertResult, WriteStamps } from "./clients.ts";

export type GigRecord = typeof gigs.$inferSelect;

// calendarEventId is NOT part of GigData — it's server-owned sync
// bookkeeping (setCalendarEventId below); upserts must never touch it.
export interface GigData {
  clientId: string | null;
  status: GigStatus;
  location: string | null;
  dateTime: number | null;
  durationMinutes: number | null;
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
        .set({ ...data, modifiedAt, serverModifiedAt: stamps.now })
        .where(and(eq(gigs.id, id), eq(gigs.userId, userId)))
        .returning();
      return { record: updated[0]!, created: false };
    }

    const inserted = await this.db
      .insert(gigs)
      .values({
        id,
        userId,
        ...data,
        createdAt: stamps.now,
        modifiedAt,
        serverModifiedAt: stamps.now,
      })
      .returning();
    return { record: inserted[0]!, created: true };
  }

  /**
   * Deleting the row destroys the only pointer to the gig's Google
   * Calendar event, so a synced gig parks its event id in the cleanup
   * queue on the way out — otherwise the event is orphaned on the
   * user's calendar forever (Phase 8 hardening plan). This lives here
   * rather than in the route because offline deletes arrive through
   * /api/sync, and both paths call remove().
   */
  async remove(userId: string, id: string): Promise<boolean> {
    const deleted = await this.db
      .delete(gigs)
      .where(and(eq(gigs.id, id), eq(gigs.userId, userId)))
      .returning({ id: gigs.id, calendarEventId: gigs.calendarEventId });

    const row = deleted[0];
    if (row === undefined) return false;
    if (row.calendarEventId !== null) {
      await this.db.insert(calendarCleanup).values({
        id: crypto.randomUUID(),
        userId,
        calendarEventId: row.calendarEventId,
        createdAt: Date.now(),
      });
    }
    return true;
  }

  /** Calendar sync input: everything touched since the watermark. */
  /**
   * Gigs the server stored after `sinceMs`. Deliberately NOT
   * `modifiedAt`: that is the authoring device's clock, and comparing
   * it to a server-stamped watermark silently drops every gig that was
   * edited offline and uploaded after the last run.
   */
  async listStoredSince(userId: string, sinceMs: number): Promise<GigRecord[]> {
    return this.db
      .select()
      .from(gigs)
      .where(and(eq(gigs.userId, userId), gt(gigs.serverModifiedAt, sinceMs)));
  }

  /** Calendar bookkeeping — deliberately no modified_at bump, so the
   * sync run doesn't re-trigger itself (and offline clients aren't
   * churned by server-side-only state). */
  async setCalendarEventId(
    userId: string,
    id: string,
    eventId: string | null,
  ): Promise<void> {
    await this.db
      .update(gigs)
      .set({ calendarEventId: eventId })
      .where(and(eq(gigs.id, id), eq(gigs.userId, userId)));
  }
}
