/**
 * The queue of calendar events whose gig has been deleted (Phase 8
 * hardening plan). Deleting a gig destroys the row that held its
 * `calendar_event_id`, so the id is parked here first and the next
 * sync run removes the event from Google. A delete that fails leaves
 * its row in place and retries on the following run.
 */
import { and, eq } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { calendarCleanup } from "../db/schema.ts";

export type CalendarCleanupRecord = typeof calendarCleanup.$inferSelect;

export class CalendarCleanupRepo {
  constructor(private readonly db: DrizzleD1Database) {}

  static for(d1: D1Database): CalendarCleanupRepo {
    return new CalendarCleanupRepo(drizzle(d1));
  }

  async enqueue(
    userId: string,
    calendarEventId: string,
    now: number,
  ): Promise<void> {
    await this.db.insert(calendarCleanup).values({
      id: crypto.randomUUID(),
      userId,
      calendarEventId,
      createdAt: now,
    });
  }

  listPending(userId: string): Promise<CalendarCleanupRecord[]> {
    return this.db
      .select()
      .from(calendarCleanup)
      .where(eq(calendarCleanup.userId, userId));
  }

  async remove(userId: string, id: string): Promise<void> {
    await this.db
      .delete(calendarCleanup)
      .where(and(eq(calendarCleanup.id, id), eq(calendarCleanup.userId, userId)));
  }
}
