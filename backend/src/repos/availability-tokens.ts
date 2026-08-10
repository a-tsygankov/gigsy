/**
 * Availability links (Phase 12).
 *
 * The token in /a/<token> is the entire access control for the public
 * page — there is no login behind it — so this store is written around
 * two rules:
 *
 * 1. Only the hash is persisted (src/lib/opaque-token.ts), as with
 *    refresh tokens. A leaked database must not hand over live links.
 * 2. A link the user has finished with stops working immediately.
 *    Rows are revoked rather than deleted, so "this stopped working"
 *    stays distinguishable from "this never existed", and issuing is
 *    revoke-then-insert rather than a delete racing a concurrent read.
 *
 * One active link per user. That is the simplest model that supports
 * "stop showing this to them": regenerate, and the old link is dead.
 */
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { availabilityTokens } from "../db/schema.ts";
import { hashToken, mintToken } from "../lib/opaque-token.ts";

/** 128 bits. Unguessable in any practical sense, and still short
 *  enough to paste into a message without wrapping. */
const TOKEN_BYTES = 16;

/** What the share screen can know about a live link. Deliberately not
 *  the link itself: nothing stored can reconstruct it. */
export interface ActiveLink {
  createdAt: number;
  expiresAt: number | null;
}

export class AvailabilityTokenStore {
  constructor(private readonly db: DrizzleD1Database) {}

  static for(d1: D1Database): AvailabilityTokenStore {
    return new AvailabilityTokenStore(drizzle(d1));
  }

  /**
   * Mint a link for the user, invalidating whatever they had.
   *
   * `ttlMs` of null means no expiry. The plan makes expiry optional
   * rather than mandatory: a link sent to an agency in March should
   * not still work in December *unless the user said so*.
   */
  async issue(userId: string, now: number, ttlMs: number | null): Promise<string> {
    await this.revokeAll(userId, now);

    const raw = mintToken(TOKEN_BYTES);
    await this.db.insert(availabilityTokens).values({
      tokenHash: await hashToken(raw),
      userId,
      createdAt: now,
      expiresAt: ttlMs === null ? null : now + ttlMs,
      revokedAt: null,
    });
    return raw;
  }

  /**
   * The user a live link belongs to, or null.
   *
   * Every reason for failure — unknown, revoked, expired — collapses
   * to null so the caller has nothing to leak in a status code. The
   * page cannot tell "never existed" from "you were cut off".
   */
  async resolve(raw: string, now: number): Promise<string | null> {
    if (raw === "") return null;

    const rows = await this.db
      .select({ userId: availabilityTokens.userId })
      .from(availabilityTokens)
      .where(
        and(
          eq(availabilityTokens.tokenHash, await hashToken(raw)),
          isNull(availabilityTokens.revokedAt),
          or(
            isNull(availabilityTokens.expiresAt),
            gt(availabilityTokens.expiresAt, now),
          ),
        ),
      );
    return rows[0]?.userId ?? null;
  }

  /** Stop every link this user has. Idempotent. */
  async revokeAll(userId: string, now: number): Promise<void> {
    await this.db
      .update(availabilityTokens)
      .set({ revokedAt: now })
      .where(
        and(
          eq(availabilityTokens.userId, userId),
          isNull(availabilityTokens.revokedAt),
        ),
      );
  }

  /** Metadata for the live link, so the share screen can say one
   *  exists and when it was made. Never the token. */
  async active(userId: string, now: number): Promise<ActiveLink | null> {
    const rows = await this.db
      .select({
        createdAt: availabilityTokens.createdAt,
        expiresAt: availabilityTokens.expiresAt,
      })
      .from(availabilityTokens)
      .where(
        and(
          eq(availabilityTokens.userId, userId),
          isNull(availabilityTokens.revokedAt),
          or(
            isNull(availabilityTokens.expiresAt),
            gt(availabilityTokens.expiresAt, now),
          ),
        ),
      );
    return rows[0] ?? null;
  }
}
