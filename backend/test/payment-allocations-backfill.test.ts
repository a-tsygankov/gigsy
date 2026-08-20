/// <reference types="@cloudflare/vitest-pool-workers" />
/**
 * Migration 0016 against rows that already exist.
 *
 * Every other suite in this repo applies migrations to an empty
 * database, which exercises the CREATE TABLE / ALTER TABLE in 0016 but
 * never a single row of its three backfill statements — exactly the
 * shape of test that let a broken backfill through in 0014 and a broken
 * FK ordering through in 0015. This file seeds the pre-0016 schema with
 * payments both with and without a gig_id, and gigs both with and
 * without a client, then applies 0016 and checks what each becomes.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import {
  applyMigrationSql,
  MIGRATIONS_BEFORE_PAYMENT_ALLOCATIONS,
  PAYMENT_ALLOCATIONS_MIGRATION,
  seedUser,
} from "./helpers/db.ts";

const U1 = "alloc-migration-user-1";

const CLIENT = "70000000-0000-4000-8000-000000000001";

// A gig with a client, and one without — the backfill's UPDATE
// payments SET client_id = (SELECT g.client_id ...) has to leave the
// second one NULL, not "no client" turned into an error.
const GIG_WITH_CLIENT = "10000000-0000-4000-8000-000000000101";
const GIG_NO_CLIENT = "10000000-0000-4000-8000-000000000102";
// A gig nobody ever paid — amount_paid_cents must be left exactly as it
// was (NULL), not zeroed, since the UPDATE gigs statement is gated on
// EXISTS(... an allocation for this gig).
const GIG_NO_PAYMENTS = "10000000-0000-4000-8000-000000000103";

// Two payments against the same gig, so the resulting amount_paid_cents
// has to be a SUM of two allocations, not either one alone.
const PAYMENT_A = "20000000-0000-4000-8000-000000000201"; // -> GIG_WITH_CLIENT, 5000
const PAYMENT_B = "20000000-0000-4000-8000-000000000202"; // -> GIG_WITH_CLIENT, 2000
const PAYMENT_C = "20000000-0000-4000-8000-000000000203"; // -> GIG_NO_CLIENT, 3000
const PAYMENT_NO_GIG = "20000000-0000-4000-8000-000000000204"; // gig_id NULL

beforeAll(async () => {
  // Everything up to but NOT including 0016: the schema rows in
  // production were actually written against.
  await applyMigrationSql(env.DB, MIGRATIONS_BEFORE_PAYMENT_ALLOCATIONS);
  await seedUser(env.DB, U1);

  await env.DB.prepare(
    `INSERT INTO clients (id, user_id, name, created_at, modified_at)
     VALUES (?, ?, 'Backfill Client', 1, 1)`,
  )
    .bind(CLIENT, U1)
    .run();

  await env.DB.prepare(
    `INSERT INTO gigs (id, user_id, client_id, status, created_at, modified_at)
     VALUES (?, ?, ?, 'completed', 1, 1)`,
  )
    .bind(GIG_WITH_CLIENT, U1, CLIENT)
    .run();
  await env.DB.prepare(
    `INSERT INTO gigs (id, user_id, status, created_at, modified_at)
     VALUES (?, ?, 'completed', 1, 1)`,
  )
    .bind(GIG_NO_CLIENT, U1)
    .run();
  await env.DB.prepare(
    `INSERT INTO gigs (id, user_id, status, created_at, modified_at)
     VALUES (?, ?, 'lead', 1, 1)`,
  )
    .bind(GIG_NO_PAYMENTS, U1)
    .run();

  for (const [id, gigId, amount] of [
    [PAYMENT_A, GIG_WITH_CLIENT, 5000],
    [PAYMENT_B, GIG_WITH_CLIENT, 2000],
    [PAYMENT_C, GIG_NO_CLIENT, 3000],
  ] as const) {
    await env.DB.prepare(
      `INSERT INTO payments (id, user_id, gig_id, amount_cents, created_at, modified_at)
       VALUES (?, ?, ?, ?, 1, 1)`,
    )
      .bind(id, U1, gigId, amount)
      .run();
  }
  // No gig at all — the case that must stay unallocated rather than
  // erroring or being dropped.
  await env.DB.prepare(
    `INSERT INTO payments (id, user_id, amount_cents, created_at, modified_at)
     VALUES (?, ?, 1000, 1, 1)`,
  )
    .bind(PAYMENT_NO_GIG, U1)
    .run();

  await applyMigrationSql(env.DB, [PAYMENT_ALLOCATIONS_MIGRATION]);
});

describe("0016 against a database that already has payments and gigs", () => {
  it("creates one allocation per payment that named a gig, and none for the one that didn't", async () => {
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM payment_allocations WHERE user_id = ?",
    )
      .bind(U1)
      .first<{ n: number }>();
    expect(row?.n).toBe(3);
  });

  it("carries the amount and gig through to each allocation", async () => {
    const rows = await env.DB.prepare(
      "SELECT payment_id, gig_id, amount_cents FROM payment_allocations WHERE user_id = ? ORDER BY payment_id",
    )
      .bind(U1)
      .all<{ payment_id: string; gig_id: string; amount_cents: number }>();
    expect(rows.results).toEqual([
      { payment_id: PAYMENT_A, gig_id: GIG_WITH_CLIENT, amount_cents: 5000 },
      { payment_id: PAYMENT_B, gig_id: GIG_WITH_CLIENT, amount_cents: 2000 },
      { payment_id: PAYMENT_C, gig_id: GIG_NO_CLIENT, amount_cents: 3000 },
    ]);
  });

  it("derives payments.client_id from the gig's client, leaving no-client and no-gig payments NULL", async () => {
    const rows = await env.DB.prepare(
      "SELECT id, client_id FROM payments WHERE user_id = ? ORDER BY id",
    )
      .bind(U1)
      .all<{ id: string; client_id: string | null }>();
    const byId = new Map(rows.results.map((r) => [r.id, r.client_id]));
    expect(byId.get(PAYMENT_A)).toBe(CLIENT);
    expect(byId.get(PAYMENT_B)).toBe(CLIENT);
    expect(byId.get(PAYMENT_C)).toBeNull();
    expect(byId.get(PAYMENT_NO_GIG)).toBeNull();
  });

  it("sums the backfilled allocations into each gig's amount_paid_cents", async () => {
    const rows = await env.DB.prepare(
      "SELECT id, amount_paid_cents FROM gigs WHERE user_id = ? ORDER BY id",
    )
      .bind(U1)
      .all<{ id: string; amount_paid_cents: number | null }>();
    const byId = new Map(rows.results.map((r) => [r.id, r.amount_paid_cents]));
    // Two payments (5000 + 2000) landed on the same gig.
    expect(byId.get(GIG_WITH_CLIENT)).toBe(7000);
    expect(byId.get(GIG_NO_CLIENT)).toBe(3000);
  });

  it("leaves a gig nobody paid at NULL rather than zeroing it", async () => {
    const row = await env.DB.prepare(
      "SELECT amount_paid_cents FROM gigs WHERE id = ?",
    )
      .bind(GIG_NO_PAYMENTS)
      .first<{ amount_paid_cents: number | null }>();
    expect(row?.amount_paid_cents).toBeNull();
  });

  it("leaves the unallocated payment's row intact, just with no allocation", async () => {
    const row = await env.DB.prepare(
      "SELECT gig_id, amount_cents FROM payments WHERE id = ?",
    )
      .bind(PAYMENT_NO_GIG)
      .first<{ gig_id: string | null; amount_cents: number }>();
    expect(row?.gig_id).toBeNull();
    expect(row?.amount_cents).toBe(1000);
    const alloc = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM payment_allocations WHERE payment_id = ?",
    )
      .bind(PAYMENT_NO_GIG)
      .first<{ n: number }>();
    expect(alloc?.n).toBe(0);
  });

  it("creates all four allocation indexes and the payments.client_id index", async () => {
    const rows = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (
         'idx_payment_allocations_user',
         'idx_payment_allocations_payment',
         'idx_payment_allocations_gig',
         'idx_payment_allocations_user_server_modified',
         'idx_payments_client'
       )`,
    ).all<{ name: string }>();
    expect(rows.results.map((r) => r.name).sort()).toEqual(
      [
        "idx_payment_allocations_user",
        "idx_payment_allocations_payment",
        "idx_payment_allocations_gig",
        "idx_payment_allocations_user_server_modified",
        "idx_payments_client",
      ].sort(),
    );
  });

  it("passes PRAGMA foreign_key_check", async () => {
    const violations = await env.DB.prepare("PRAGMA foreign_key_check").all();
    expect(violations.results).toEqual([]);
  });
});
