/**
 * Opaque rotating refresh tokens (docs/plan.md §6). The raw token —
 * 32 random bytes, base64url — goes to the client exactly once; D1
 * keeps only its SHA-256 hash. `consume` is delete-on-read, which IS
 * the rotation: a replayed (stolen or duplicated) token finds no row.
 */
import { and, eq, gt } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { refreshTokens } from "../db/schema.ts";

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export class RefreshTokenStore {
  constructor(private readonly db: DrizzleD1Database) {}

  static for(d1: D1Database): RefreshTokenStore {
    return new RefreshTokenStore(drizzle(d1));
  }

  /** Mint a raw token for the user and persist only its hash. */
  async issue(userId: string, now: number, ttlMs: number): Promise<string> {
    const raw = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    await this.db.insert(refreshTokens).values({
      tokenHash: await sha256Hex(raw),
      userId,
      expiresAt: now + ttlMs,
      createdAt: now,
    });
    return raw;
  }

  /** Redeem a raw token: returns its userId and deletes the row
   * (one-shot). Expired/unknown → null. */
  async consume(raw: string, now: number): Promise<string | null> {
    const tokenHash = await sha256Hex(raw);
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
