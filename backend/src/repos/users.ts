/**
 * Users are keyed by email at the auth boundary (Google sign-in) and
 * by UUID everywhere else. The Google refresh token is only ever
 * stored encrypted (src/auth/crypto.ts) — this repo never sees the
 * plaintext.
 */
import { eq, isNotNull } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { users } from "../db/schema.ts";

export type UserRecord = typeof users.$inferSelect;

export class UsersRepo {
  constructor(private readonly db: DrizzleD1Database) {}

  static for(d1: D1Database): UsersRepo {
    return new UsersRepo(drizzle(d1));
  }

  async get(id: string): Promise<UserRecord | null> {
    const rows = await this.db.select().from(users).where(eq(users.id, id));
    return rows[0] ?? null;
  }

  /** Login-time upsert: returns the existing user for the email or
   * creates one with a fresh UUID. */
  async upsertByEmail(email: string, now: number): Promise<UserRecord> {
    const existing = await this.db
      .select()
      .from(users)
      .where(eq(users.email, email));
    if (existing[0] !== undefined) return existing[0];

    const inserted = await this.db
      .insert(users)
      .values({
        id: crypto.randomUUID(),
        email,
        createdAt: now,
        modifiedAt: now,
      })
      .returning();
    return inserted[0]!;
  }

  async setGoogleRefreshTokenEnc(
    userId: string,
    encrypted: string | null,
    now: number,
  ): Promise<void> {
    await this.db
      .update(users)
      .set({ googleRefreshTokenEnc: encrypted, modifiedAt: now })
      .where(eq(users.id, userId));
  }

  /** Users with calendar consent — the cron's work list. */
  async listConnected(): Promise<UserRecord[]> {
    return this.db
      .select()
      .from(users)
      .where(isNotNull(users.googleRefreshTokenEnc));
  }

  /** Sync bookkeeping — deliberately no modified_at bump. */
  async setLastCalendarSyncAt(userId: string, ts: number): Promise<void> {
    await this.db
      .update(users)
      .set({ lastCalendarSyncAt: ts })
      .where(eq(users.id, userId));
  }
}
