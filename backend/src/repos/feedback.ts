/**
 * Data access for feedback rows (migration 0021).
 *
 * Narrower than the entity repos on purpose: feedback is born
 * server-side (routes/feedback.ts) and only its mail status ever
 * changes, once. There is no list, no get, no delete — the mail is the
 * admin UI and nothing in the app reads a row back. The two reads that
 * exist are the daily-cap count and the `.returning()` the insert hands
 * the mail builder.
 */
import { and, count, eq, gte } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import {
  feedback,
  type FeedbackEmailStatus,
  type FeedbackImage,
} from "../db/schema.ts";

export type FeedbackRecord = typeof feedback.$inferSelect;

export interface NewFeedback {
  id: string;
  userEmail: string;
  message: string;
  page: string | null;
  clientVersion: string | null;
  userAgent: string | null;
  images: FeedbackImage[];
  /** What the row says before any mail is attempted. The route inserts
   *  `unsent` and moves it with setEmailStatus — so a crash mid-send
   *  leaves a row that is honest about what happened to the mail. */
  emailStatus: FeedbackEmailStatus;
  now: number;
}

export class FeedbackRepo {
  constructor(private readonly db: DrizzleD1Database) {}

  static for(d1: D1Database): FeedbackRepo {
    return new FeedbackRepo(drizzle(d1));
  }

  async insert(userId: string, input: NewFeedback): Promise<FeedbackRecord> {
    const inserted = await this.db
      .insert(feedback)
      .values({
        id: input.id,
        userId,
        userEmail: input.userEmail,
        message: input.message,
        page: input.page,
        clientVersion: input.clientVersion,
        userAgent: input.userAgent,
        imagesJson: JSON.stringify(input.images),
        emailStatus: input.emailStatus,
        emailError: null,
        createdAt: input.now,
      })
      .returning();
    return inserted[0]!;
  }

  /**
   * Submissions since `sinceMs` — the daily-cap input, the same shape
   * as DraftsRepo.countSince for the capture budget. Counted in SQL
   * over idx_feedback_user_created rather than fetched and filtered:
   * a count is the only question this table is ever asked.
   */
  async countSince(userId: string, sinceMs: number): Promise<number> {
    const rows = await this.db
      .select({ n: count() })
      .from(feedback)
      .where(and(eq(feedback.userId, userId), gte(feedback.createdAt, sinceMs)));
    return rows[0]?.n ?? 0;
  }

  /**
   * Record what happened to the mail. `error` is the binding's message
   * when it threw and null otherwise; passing null on `sent` clears
   * nothing because nothing was ever set — the row starts `unsent`
   * with no error.
   */
  async setEmailStatus(
    id: string,
    status: FeedbackEmailStatus,
    error: string | null = null,
  ): Promise<void> {
    await this.db
      .update(feedback)
      .set({ emailStatus: status, emailError: error })
      .where(eq(feedback.id, id));
  }
}
