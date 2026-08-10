/**
 * Opaque rotating refresh tokens (docs/plan.md §6). The raw token —
 * 32 random bytes, base64url — goes to the client exactly once; D1
 * keeps only its SHA-256 hash. `consume` is delete-on-read, which IS
 * the rotation: a replayed (stolen or duplicated) token finds no row.
 */
import { and, eq, gt } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { refreshTokens } from "../db/schema.ts";
import { hashToken, mintToken } from "../lib/opaque-token.ts";

/** 256 bits. Availability links (Phase 12) settle for 128; a refresh
 *  token buys a session, so it keeps the wider margin it shipped with. */
const TOKEN_BYTES = 32;

export class RefreshTokenStore {
  constructor(private readonly db: DrizzleD1Database) {}

  static for(d1: D1Database): RefreshTokenStore {
    return new RefreshTokenStore(drizzle(d1));
  }

  /** Mint a raw token for the user and persist only its hash. */
  async issue(userId: string, now: number, ttlMs: number): Promise<string> {
    const raw = mintToken(TOKEN_BYTES);
    await this.db.insert(refreshTokens).values({
      tokenHash: await hashToken(raw),
      userId,
      expiresAt: now + ttlMs,
      createdAt: now,
    });
    return raw;
  }

  /** Redeem a raw token: returns its userId and deletes the row
   * (one-shot). Expired/unknown → null. */
  async consume(raw: string, now: number): Promise<string | null> {
    const tokenHash = await hashToken(raw);
    const deleted = await this.db
      .delete(refreshTokens)
      .where(
        and(
          eq(refreshTokens.tokenHash, tokenHash),
          gt(refreshTokens.expiresAt, now),
        ),
      )
      .returning({ userId: refreshTokens.userId });
    return deleted[0]?.userId ?? null;
  }
}
