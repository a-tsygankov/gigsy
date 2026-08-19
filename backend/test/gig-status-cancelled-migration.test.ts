/// <reference types="@cloudflare/vitest-pool-workers" />
/**
 * Migration 0015 against rows that already exist — specifically rows
 * in the three tables that hold a foreign key into gigs.id.
 *
 * Every other suite applies migrations to an empty database, so the
 * DROP TABLE gigs at the heart of 0015's rebuild never has to contend
 * with a payment, service or expense still pointing at a row about to
 * be removed. That was exactly the wrong shape of test: D1 enforces
 * foreign keys inside migrations (PRAGMA foreign_keys=off is accepted
 * and silently ignored), and the first version of this migration
 * failed with SQLITE_CONSTRAINT_FOREIGNKEY the moment it ran against a
 * database that actually had children in payments, gig_services or
 * expenses. This file seeds the pre-0015 schema with a gig of every
 * status plus a payment, a service and an expense hanging off them,
 * applies 0015, and checks that nothing was lost or orphaned.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import {
  applyMigrationSql,
  MIGRATIONS_BEFORE_STATUS_CANCELLED,
  STATUS_CANCELLED_MIGRATION,
  seedUser,
} from "./helpers/db.ts";

const U1 = "status-migration-user-1";

const LEAD = "10000000-0000-4000-8000-000000000001";
const CONFIRMED = "10000000-0000-4000-8000-000000000002";
const COMPLETED = "10000000-0000-4000-8000-000000000003";
const PAID = "10000000-0000-4000-8000-000000000004";

const PAYMENT = "20000000-0000-4000-8000-000000000001";
const SERVICE = "30000000-0000-4000-8000-000000000001";
const EXPENSE = "40000000-0000-4000-8000-000000000001";

beforeAll(async () => {
  // Everything up to but NOT including 0015: the schema rows in
  // production were actually written against.
  await applyMigrationSql(env.DB, MIGRATIONS_BEFORE_STATUS_CANCELLED);
  await seedUser(env.DB, U1);

  for (const [id, status] of [
    [LEAD, "lead"],
    [CONFIRMED, "confirmed"],
    [COMPLETED, "completed"],
    [PAID, "paid"],
  ] as const) {
    await env.DB.prepare(
      `INSERT INTO gigs (id, user_id, status, created_at, modified_at)
       VALUES (?, ?, ?, 1, 1)`,
    )
      .bind(id, U1, status)
      .run();
  }

  // A payment against the 'paid' gig — the case this whole migration
  // exists for.
  await env.DB.prepare(
    `INSERT INTO payments (id, user_id, gig_id, amount_cents, created_at, modified_at)
     VALUES (?, ?, ?, 8000, 1, 1)`,
  )
    .bind(PAYMENT, U1, PAID)
    .run();

  // A service on the completed gig, itself linked back to the payment
  // above — the row that makes clearing order matter: gig_services
  // references payments.id as well as gigs.id, so payments has to
  // survive until gig_services has been cleared, not before.
  await env.DB.prepare(
    `INSERT INTO gig_services
       (id, user_id, gig_id, description, amount_offered_cents, payment_id, created_at, modified_at)
     VALUES (?, ?, ?, 'Overtime', 4000, ?, 1, 1)`,
  )
    .bind(SERVICE, U1, COMPLETED, PAYMENT)
    .run();

  // An expense against the confirmed gig.
  await env.DB.prepare(
    `INSERT INTO expenses (id, user_id, gig_id, amount_cents, created_at, modified_at)
     VALUES (?, ?, ?, 2000, 1, 1)`,
  )
    .bind(EXPENSE, U1, CONFIRMED)
    .run();

  await applyMigrationSql(env.DB, [STATUS_CANCELLED_MIGRATION]);
});

describe("0015 against a database that already has children", () => {
  it("does not lose a single gig", async () => {
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM gigs WHERE user_id = ?",
    )
      .bind(U1)
      .first<{ n: number }>();
    expect(row?.n).toBe(4);
  });

  it("maps 'paid' to 'completed' and leaves every other status alone", async () => {
    const rows = await env.DB.prepare(
      "SELECT id, status FROM gigs WHERE user_id = ?",
    )
      .bind(U1)
      .all<{ id: string; status: string }>();
    const byId = new Map(rows.results.map((r) => [r.id, r.status]));
    expect(byId.get(LEAD)).toBe("lead");
    expect(byId.get(CONFIRMED)).toBe("confirmed");
    expect(byId.get(COMPLETED)).toBe("completed");
    expect(byId.get(PAID)).toBe("completed");
  });

  it("accepts a fresh 'cancelled' gig — the CHECK constraint actually widened", async () => {
    const id = "10000000-0000-4000-8000-000000000005";
    await env.DB.prepare(
      `INSERT INTO gigs (id, user_id, status, created_at, modified_at)
       VALUES (?, ?, 'cancelled', 1, 1)`,
    )
      .bind(id, U1)
      .run();
    const row = await env.DB.prepare("SELECT status FROM gigs WHERE id = ?")
      .bind(id)
      .first<{ status: string }>();
    expect(row?.status).toBe("cancelled");
  });

  it("still refuses 'paid' — the constraint was replaced, not merely widened", async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO gigs (id, user_id, status, created_at, modified_at)
         VALUES (?, ?, 'paid', 1, 1)`,
      )
        .bind("10000000-0000-4000-8000-000000000006", U1)
        .run(),
    ).rejects.toThrow();
  });

  it("carries the payment through, unorphaned", async () => {
    const row = await env.DB.prepare(
      "SELECT gig_id, amount_cents FROM payments WHERE id = ?",
    )
      .bind(PAYMENT)
      .first<{ gig_id: string; amount_cents: number }>();
    expect(row?.gig_id).toBe(PAID);
    expect(row?.amount_cents).toBe(8000);

    // "Unorphaned" means the row it points at still actually exists,
    // not just that the id string survived the round trip.
    const parent = await env.DB.prepare("SELECT id FROM gigs WHERE id = ?")
      .bind(PAID)
      .first();
    expect(parent).not.toBeNull();
  });

  it("carries the service through, both foreign keys intact", async () => {
    const row = await env.DB.prepare(
      "SELECT gig_id, payment_id, amount_offered_cents FROM gig_services WHERE id = ?",
    )
      .bind(SERVICE)
      .first<{
        gig_id: string;
        payment_id: string | null;
        amount_offered_cents: number;
      }>();
    expect(row?.gig_id).toBe(COMPLETED);
    expect(row?.payment_id).toBe(PAYMENT);
    expect(row?.amount_offered_cents).toBe(4000);
  });

  it("carries the expense through, unorphaned", async () => {
    const row = await env.DB.prepare(
      "SELECT gig_id, amount_cents FROM expenses WHERE id = ?",
    )
      .bind(EXPENSE)
      .first<{ gig_id: string; amount_cents: number }>();
    expect(row?.gig_id).toBe(CONFIRMED);
    expect(row?.amount_cents).toBe(2000);
  });

  it("leaves every child table's row count exactly where it started", async () => {
    const [payments, gigServices, expenses] = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) AS n FROM payments WHERE user_id = ?")
        .bind(U1)
        .first<{ n: number }>(),
      env.DB.prepare("SELECT COUNT(*) AS n FROM gig_services WHERE user_id = ?")
        .bind(U1)
        .first<{ n: number }>(),
      env.DB.prepare("SELECT COUNT(*) AS n FROM expenses WHERE user_id = ?")
        .bind(U1)
        .first<{ n: number }>(),
    ]);
    expect(payments?.n).toBe(1);
    expect(gigServices?.n).toBe(1);
    expect(expenses?.n).toBe(1);
  });
});
