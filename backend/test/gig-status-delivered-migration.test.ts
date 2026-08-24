/// <reference types="@cloudflare/vitest-pool-workers" />
/**
 * Migration 0017 against rows that already exist — specifically rows in
 * the FOUR tables that hold a foreign key into gigs.id.
 *
 * 0015's equivalent test exists because D1 enforces foreign keys inside
 * migrations and the first draft of that migration died with
 * SQLITE_CONSTRAINT_FOREIGNKEY against a database that actually had
 * children. 0016 then added a fourth such table, payment_allocations,
 * which 0015 never had to stage. If 0017 forgets it, this is the file
 * that says so.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import {
  applyMigrationSql,
  MIGRATIONS_BEFORE_DELIVERED_STATUS,
  DELIVERED_STATUS_MIGRATION,
  seedUser,
} from "./helpers/db.ts";

const U1 = "delivered-migration-user-1";

const LEAD = "10000000-0000-4000-8000-000000000011";
const CONFIRMED = "10000000-0000-4000-8000-000000000012";
const COMPLETED = "10000000-0000-4000-8000-000000000013";
const CANCELLED = "10000000-0000-4000-8000-000000000014";

const CLIENT = "50000000-0000-4000-8000-000000000001";
const PAYMENT = "20000000-0000-4000-8000-000000000011";
const SERVICE = "30000000-0000-4000-8000-000000000011";
const EXPENSE = "40000000-0000-4000-8000-000000000011";
const ALLOCATION = "60000000-0000-4000-8000-000000000011";

async function seedGig(id: string, status: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO gigs (id, user_id, status, created_at, modified_at)
     VALUES (?1, ?2, ?3, 1000, 1000)`,
  )
    .bind(id, U1, status)
    .run();
}

describe("0017: gigs.status gains 'delivered'", () => {
  beforeAll(async () => {
    await applyMigrationSql(env.DB, MIGRATIONS_BEFORE_DELIVERED_STATUS);
    await seedUser(env.DB, U1);

    await env.DB.prepare(
      `INSERT INTO clients (id, user_id, name, created_at, modified_at)
       VALUES (?1, ?2, 'Acme', 1000, 1000)`,
    )
      .bind(CLIENT, U1)
      .run();

    await seedGig(LEAD, "lead");
    await seedGig(CONFIRMED, "confirmed");
    await seedGig(COMPLETED, "completed");
    await seedGig(CANCELLED, "cancelled");

    // One child in each of the four tables that reference gigs.id.
    await env.DB.prepare(
      `INSERT INTO payments (id, user_id, gig_id, amount_cents, created_at, modified_at)
       VALUES (?1, ?2, ?3, 15000, 1000, 1000)`,
    )
      .bind(PAYMENT, U1, COMPLETED)
      .run();
    await env.DB.prepare(
      `INSERT INTO gig_services (id, user_id, gig_id, description, created_at, modified_at)
       VALUES (?1, ?2, ?3, 'Overtime', 1000, 1000)`,
    )
      .bind(SERVICE, U1, COMPLETED)
      .run();
    await env.DB.prepare(
      `INSERT INTO expenses (id, user_id, gig_id, amount_cents, created_at, modified_at)
       VALUES (?1, ?2, ?3, 2350, 1000, 1000)`,
    )
      .bind(EXPENSE, U1, COMPLETED)
      .run();
    await env.DB.prepare(
      `INSERT INTO payment_allocations
         (id, user_id, payment_id, gig_id, amount_cents, created_at, modified_at)
       VALUES (?1, ?2, ?3, ?4, 15000, 1000, 1000)`,
    )
      .bind(ALLOCATION, U1, PAYMENT, COMPLETED)
      .run();

    await applyMigrationSql(env.DB, [DELIVERED_STATUS_MIGRATION]);
  });

  it("accepts a gig set to delivered", async () => {
    await seedGig("10000000-0000-4000-8000-000000000015", "delivered");
    const row = await env.DB.prepare(
      `SELECT status FROM gigs WHERE id = ?1`,
    )
      .bind("10000000-0000-4000-8000-000000000015")
      .first<{ status: string }>();
    expect(row?.status).toBe("delivered");
  });

  it("still rejects a status outside the enum", async () => {
    await expect(
      seedGig("10000000-0000-4000-8000-000000000016", "invoiced"),
    ).rejects.toThrow();
  });

  it("keeps every pre-existing status, including cancelled", async () => {
    const rows = await env.DB.prepare(
      `SELECT id, status FROM gigs WHERE user_id = ?1 ORDER BY id`,
    )
      .bind(U1)
      .all<{ id: string; status: string }>();
    const byId = new Map(rows.results.map((r) => [r.id, r.status]));
    expect(byId.get(LEAD)).toBe("lead");
    expect(byId.get(CONFIRMED)).toBe("confirmed");
    expect(byId.get(COMPLETED)).toBe("completed");
    expect(byId.get(CANCELLED)).toBe("cancelled");
  });

  it("keeps every child row in all four referencing tables", async () => {
    // payment_allocations is the one 0015 never had to stage. If 0017
    // forgot it, the migration would have failed outright — but if it
    // staged and never restored, this is what notices.
    for (const [table, id] of [
      ["payments", PAYMENT],
      ["gig_services", SERVICE],
      ["expenses", EXPENSE],
      ["payment_allocations", ALLOCATION],
    ] as const) {
      const row = await env.DB.prepare(
        `SELECT gig_id FROM ${table} WHERE id = ?1`,
      )
        .bind(id)
        .first<{ gig_id: string }>();
      expect(row?.gig_id, `${table} lost its row`).toBe(COMPLETED);
    }
  });
});
