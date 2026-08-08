/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations, seedUser } from "./helpers/db.ts";
import { RefreshTokenStore } from "../src/auth/refresh-store.ts";

const U1 = "user-1";
const DAY = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  await applyMigrations(env.DB);
  await seedUser(env.DB, U1);
});

describe("RefreshTokenStore", () => {
  it("issues a raw token and consumes it back to the userId", async () => {
    const store = RefreshTokenStore.for(env.DB);
    const raw = await store.issue(U1, 1000, 30 * DAY);
    expect(raw.length).toBeGreaterThanOrEqual(32);

    const userId = await store.consume(raw, 2000);
    expect(userId).toBe(U1);
  });

  it("consume is one-shot (rotation): second use fails", async () => {
    const store = RefreshTokenStore.for(env.DB);
    const raw = await store.issue(U1, 1000, 30 * DAY);

    expect(await store.consume(raw, 2000)).toBe(U1);
    expect(await store.consume(raw, 3000)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const store = RefreshTokenStore.for(env.DB);
    const raw = await store.issue(U1, 1000, DAY);
    expect(await store.consume(raw, 1000 + DAY + 1)).toBeNull();
  });

  it("rejects an unknown token", async () => {
    const store = RefreshTokenStore.for(env.DB);
    expect(await store.consume("made-up-token", 1000)).toBeNull();
  });

  it("never stores the raw token", async () => {
    const store = RefreshTokenStore.for(env.DB);
    const raw = await store.issue(U1, 1000, DAY);
    const rows = await env.DB.prepare(
      "SELECT token_hash FROM refresh_tokens",
    ).all<{ token_hash: string }>();
    expect(rows.results.length).toBeGreaterThan(0);
    for (const row of rows.results) {
      expect(row.token_hash).not.toBe(raw);
    }
  });
});
