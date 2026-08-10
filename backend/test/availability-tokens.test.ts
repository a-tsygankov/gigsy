/// <reference types="@cloudflare/vitest-pool-workers" />
/**
 * Availability links (Phase 12, Task 2).
 *
 * The token IS the access control for /api/a/:token — there is no
 * login behind it — so these tests are about the two properties that
 * make that acceptable: the database never holds anything that could
 * be replayed as a link, and a link the user has finished with stops
 * working immediately.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations, seedUser } from "./helpers/db.ts";
import { AvailabilityTokenStore } from "../src/repos/availability-tokens.ts";
import { hashToken, mintToken } from "../src/lib/opaque-token.ts";

const U1 = "avail-token-user-1";
const U2 = "avail-token-user-2";
const NOW = Date.parse("2026-08-10T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

const store = (): AvailabilityTokenStore => AvailabilityTokenStore.for(env.DB);

beforeAll(async () => {
  await applyMigrations(env.DB);
  await seedUser(env.DB, U1);
  await seedUser(env.DB, U2, "avail-token-two@example.com");
});

describe("mintToken / hashToken", () => {
  it("mints a URL-safe token with no padding", () => {
    // It goes in a path segment that people paste into chat apps.
    expect(mintToken(16)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("mints 128 bits, which is 22 base64url characters", () => {
    expect(mintToken(16)).toHaveLength(22);
  });

  it("does not repeat itself", () => {
    const seen = new Set(Array.from({ length: 50 }, () => mintToken(16)));
    expect(seen.size).toBe(50);
  });

  it("hashes stably, and differently for different inputs", async () => {
    expect(await hashToken("abc")).toBe(await hashToken("abc"));
    expect(await hashToken("abc")).not.toBe(await hashToken("abd"));
  });
});

describe("AvailabilityTokenStore", () => {
  it("issues a token that resolves to its user", async () => {
    const raw = await store().issue(U1, NOW, null);

    expect(await store().resolve(raw, NOW)).toBe(U1);
  });

  it("stores only a hash, never anything replayable", async () => {
    // The test that justifies hashing at all: a database dump must not
    // contain a working link.
    const raw = await store().issue(U1, NOW, null);

    const rows = await env.DB.prepare(
      "SELECT token_hash FROM availability_tokens WHERE user_id = ?",
    )
      .bind(U1)
      .all();

    const hashes = rows.results.map((r) => (r as { token_hash: string }).token_hash);
    expect(hashes).not.toContain(raw);
    expect(hashes).toContain(await hashToken(raw));
  });

  it("does not resolve a token it never issued", async () => {
    expect(await store().resolve("not-a-real-token", NOW)).toBeNull();
  });

  it("does not resolve an empty token", async () => {
    // A bare /api/a/ must not hash the empty string into a hit.
    expect(await store().resolve("", NOW)).toBeNull();
  });

  it("stops resolving once revoked", async () => {
    const raw = await store().issue(U1, NOW, null);

    await store().revokeAll(U1, NOW + HOUR);

    expect(await store().resolve(raw, NOW + 2 * HOUR)).toBeNull();
  });

  it("stops resolving once expired", async () => {
    const raw = await store().issue(U1, NOW, 24 * HOUR);

    expect(await store().resolve(raw, NOW + 23 * HOUR)).toBe(U1);
    expect(await store().resolve(raw, NOW + 25 * HOUR)).toBeNull();
  });

  it("keeps working indefinitely when no expiry was asked for", async () => {
    const raw = await store().issue(U1, NOW, null);

    expect(await store().resolve(raw, NOW + 365 * 24 * HOUR)).toBe(U1);
  });

  it("invalidates the previous link when a new one is issued", async () => {
    // One active token at a time — "regenerate" must actually stop
    // showing the page to whoever held the old link.
    const old = await store().issue(U1, NOW, null);
    const fresh = await store().issue(U1, NOW + HOUR, null);

    expect(await store().resolve(old, NOW + 2 * HOUR)).toBeNull();
    expect(await store().resolve(fresh, NOW + 2 * HOUR)).toBe(U1);
  });

  it("keeps one user's link out of another's account", async () => {
    const mine = await store().issue(U1, NOW, null);
    await store().issue(U2, NOW, null);

    expect(await store().resolve(mine, NOW)).toBe(U1);
  });

  it("revoking one user's links leaves another's alone", async () => {
    const theirs = await store().issue(U2, NOW, null);
    await store().issue(U1, NOW, null);

    await store().revokeAll(U1, NOW + HOUR);

    expect(await store().resolve(theirs, NOW + 2 * HOUR)).toBe(U2);
  });

  it("describes the active link without being able to reproduce it", async () => {
    // The share screen can say "a link is active, made on the 10th" —
    // it cannot show the link again, because nothing stored can
    // reconstruct it. That is the cost of hashing, and it is the point.
    const raw = await store().issue(U1, NOW, 24 * HOUR);

    const active = await store().active(U1, NOW);

    expect(active).toEqual({ createdAt: NOW, expiresAt: NOW + 24 * HOUR });
    expect(JSON.stringify(active)).not.toContain(raw);
  });

  it("reports no active link after revocation", async () => {
    await store().issue(U1, NOW, null);
    await store().revokeAll(U1, NOW + HOUR);

    expect(await store().active(U1, NOW + 2 * HOUR)).toBeNull();
  });

  it("reports no active link once the only one expired", async () => {
    await store().issue(U1, NOW, HOUR);

    expect(await store().active(U1, NOW + 2 * HOUR)).toBeNull();
  });
});
