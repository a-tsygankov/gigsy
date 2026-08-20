/**
 * User-scoped data access for capture drafts. Unlike the entity
 * repos there is no client-driven upsert — drafts are born
 * server-side (capture endpoints) and only their STATUS moves, and
 * only out of `pending` (one-way review gate).
 */
import { and, desc, eq } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { drafts, type DraftSource, type DraftStatus } from "../db/schema.ts";

export type DraftRecord = typeof drafts.$inferSelect;

export interface NewDraft {
  id: string;
  source: DraftSource;
  status?: DraftStatus;
  rawR2Key: string | null;
  extractedJson: string;
  now: number;
}

export class DraftsRepo {
  constructor(private readonly db: DrizzleD1Database) {}

  static for(d1: D1Database): DraftsRepo {
    return new DraftsRepo(drizzle(d1));
  }

  async insert(userId: string, draft: NewDraft): Promise<DraftRecord> {
    const inserted = await this.db
      .insert(drafts)
      .values({
        id: draft.id,
        userId,
        source: draft.source,
        status: draft.status ?? "pending",
        rawR2Key: draft.rawR2Key,
        extractedJson: draft.extractedJson,
        createdAt: draft.now,
        modifiedAt: draft.now,
      })
      .returning();
    return inserted[0]!;
  }

  async list(userId: string, status?: DraftStatus): Promise<DraftRecord[]> {
    const where =
      status === undefined
        ? eq(drafts.userId, userId)
        : and(eq(drafts.userId, userId), eq(drafts.status, status));
    return this.db
      .select()
      .from(drafts)
      .where(where)
      .orderBy(desc(drafts.createdAt));
  }

  async get(userId: string, id: string): Promise<DraftRecord | null> {
    const rows = await this.db
      .select()
      .from(drafts)
      .where(and(eq(drafts.id, id), eq(drafts.userId, userId)));
    return rows[0] ?? null;
  }

  /** Count captures created since `sinceMs` — the AI rate cap input. */
  async countSince(userId: string, sinceMs: number): Promise<number> {
    const rows = await this.db
      .select({ id: drafts.id })
      .from(drafts)
      .where(eq(drafts.userId, userId));
    return rows.length === 0
      ? 0
      : (await this.list(userId)).filter((d) => d.createdAt >= sinceMs).length;
  }

  /**
   * Only `pending` drafts may transition (one-way review gate).
   *
   * The `eq(drafts.status, "pending")` in the WHERE clause is load-
   * bearing, not decorative: this used to be read-then-write (SELECT,
   * check in JS, UPDATE), and two concurrent confirmations of the same
   * draft could both pass the JS check before either write landed —
   * proven by a two-request race against POST
   * /api/drafts/:id/confirm-payment, which created two payments from
   * one receipt. Folding the check into the UPDATE's WHERE makes the
   * transition a single atomic compare-and-set: of two concurrent
   * callers, at most one UPDATE can match a still-`pending` row, so at
   * most one gets a record back. The other gets zero rows — which the
   * one extra SELECT below turns into "not-found" or "conflict" for
   * the caller's error message, but only after the race is already
   * decided.
   */
  async setStatus(
    userId: string,
    id: string,
    status: Exclude<DraftStatus, "pending">,
    now: number,
  ): Promise<DraftRecord | "not-found" | "conflict"> {
    const updated = await this.db
      .update(drafts)
      .set({ status, modifiedAt: now })
      .where(
        and(
          eq(drafts.id, id),
          eq(drafts.userId, userId),
          eq(drafts.status, "pending"),
        ),
      )
      .returning();
    if (updated[0] !== undefined) return updated[0];
    const existing = await this.get(userId, id);
    return existing === null ? "not-found" : "conflict";
  }
}
