/** User-scoped data access for `gigs`. Same contract as ClientsRepo. */
import { and, desc, eq, gt, gte, inArray, isNotNull, lte } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { calendarCleanup, gigs, type GigStatus } from "../db/schema.ts";
import { MAX_GIG_DURATION_MS, type TimedGig } from "../domain/gig-time.ts";
import { expectedCents, type PayType } from "../domain/gig-pay.ts";
import type { UpsertResult, WriteStamps } from "./clients.ts";

export type GigRecord = typeof gigs.$inferSelect;

// calendarEventId is NOT part of GigData — it's server-owned sync
// bookkeeping (setCalendarEventId below); upserts must never touch it.
// expectedCents is absent for the same reason, and upsert() derives it
// below: it is what every money total sums (migration 0014), so a
// caller — including an offline client posting to /api/sync — must not
// be able to name it.
export interface GigData {
  clientId: string | null;
  title: string | null;
  status: GigStatus;
  location: string | null;
  dateTime: number | null;
  durationMinutes: number | null;
  payType: PayType;
  hourlyRateCents: number | null;
  workStartedAt: number | null;
  workEndedAt: number | null;
  breakMinutes: number | null;
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

    // Derived here rather than by each caller, because this is the one
    // place both write paths meet: the CRUD route and the /api/sync
    // batch. Recomputing on every write — insert and update alike — is
    // what makes the column unable to drift from the fields it is
    // derived from; an update that moves the work times but leaves a
    // stale figure behind would be worse than no column at all.
    // `data` is a GigData, which carries every PayableGig field.
    const stored = { ...data, expectedCents: expectedCents(data) };

    if (existing !== undefined) {
      const updated = await this.db
        .update(gigs)
        .set({ ...stored, modifiedAt, serverModifiedAt: stamps.now })
        .where(and(eq(gigs.id, id), eq(gigs.userId, userId)))
        .returning();
      return { record: updated[0]!, created: false };
    }

    const inserted = await this.db
      .insert(gigs)
      .values({
        id,
        userId,
        ...stored,
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
  /** Gigs that currently hold a Google event id. Used when switching
   *  calendars: their events live on the OLD calendar and have to be
   *  removed there before the ids are cleared. */
  async listWithCalendarEvent(
    userId: string,
  ): Promise<{ id: string; calendarEventId: string }[]> {
    const rows = await this.db
      .select({ id: gigs.id, calendarEventId: gigs.calendarEventId })
      .from(gigs)
      .where(and(eq(gigs.userId, userId), isNotNull(gigs.calendarEventId)));
    return rows as { id: string; calendarEventId: string }[];
  }

  /** Forget every event id, so the next sync re-creates them. Does not
   *  touch serverModifiedAt: this is bookkeeping, not a user edit, and
   *  the caller resets the watermark to force the re-push. */
  async clearAllCalendarEventIds(userId: string): Promise<void> {
    await this.db
      .update(gigs)
      .set({ calendarEventId: null })
      .where(and(eq(gigs.userId, userId), isNotNull(gigs.calendarEventId)));
  }

  /**
   * When this user is occupied between two instants — times only.
   *
   * Two deliberate choices, both about the public availability page
   * (Phase 12) that this feeds:
   *
   * - The projection is `{ dateTime, durationMinutes }` and nothing
   *   else. Not a convenience: the client name, location and amount
   *   never enter the worker on this path, so the endpoint above
   *   cannot serialise what it was never given. The privacy rule
   *   becomes structural instead of a thing to remember.
   * - `statuses` is a parameter rather than a constant here, because
   *   which states count as busy is a product decision (leads never
   *   block) and belongs with the caller that made it.
   *
   * The lower bound reaches back a full day before the window: a gig
   * that started yesterday evening can still be running now, and
   * MAX_GIG_DURATION_MS is how far back it is worth looking.
   */
  async listBusyBetween(
    userId: string,
    fromMs: number,
    toMs: number,
    statuses: readonly GigStatus[],
  ): Promise<TimedGig[]> {
    if (statuses.length === 0) return [];

    return this.db
      .select({
        dateTime: gigs.dateTime,
        durationMinutes: gigs.durationMinutes,
      })
      .from(gigs)
      .where(
        and(
          eq(gigs.userId, userId),
          inArray(gigs.status, [...statuses]),
          isNotNull(gigs.dateTime),
          gte(gigs.dateTime, fromMs - MAX_GIG_DURATION_MS),
          lte(gigs.dateTime, toMs),
        ),
      );
  }

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
