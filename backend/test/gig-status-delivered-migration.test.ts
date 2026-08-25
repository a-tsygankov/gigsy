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
 *
 * It is also the only file that applies 0017 straight through against a
 * populated fixture, so it carries the whole-database integrity checks
 * (PRAGMA foreign_key_check, no leftover stage tables) and the
 * every-column fixture that the 22-column INSERT ... SELECT needs.
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

// Distinct per table on purpose: a restore that put the right NUMBER of
// rows back into the wrong table would still satisfy a check that only
// reads gig_id.
const PAYMENT_CENTS = 15000;
const SERVICE_CENTS = 4400;
const EXPENSE_CENTS = 2350;
const ALLOCATION_CENTS = 9900;

/**
 * A fifth gig, seeded with a distinct value in EVERY column rather than
 * the five the other fixtures touch. 0017's INSERT ... SELECT names all
 * 22 columns twice, and a transposition between two adjacent same-type
 * columns — notes/source, location/title, any two *_cents — silently
 * exchanges those values for every gig in the database while every row
 * count, every foreign key and every status still checks out. 0015
 * carries this same fixture for this same reason: one that only ever
 * sets id/user_id/status/created_at/modified_at cannot see a swap
 * between any of the other seventeen.
 */
const FULL_COLUMN_GIG = "10000000-0000-4000-8000-00000000001f";
const FULL_COLUMN_VALUES = {
  title: "Column Mapping Gig",
  location: "42 Test Street",
  dateTime: 1_000_000_000_001,
  durationMinutes: 111,
  calendarEventId: "evt-full-column-check",
  amountOfferedCents: 222_222,
  amountPaidCents: 333_333,
  expectedCents: 444_444,
  payType: "hourly",
  hourlyRateCents: 555_555,
  workStartedAt: 666_666_666_666,
  workEndedAt: 777_777_777_777,
  breakMinutes: 88,
  notes: "Full column mapping notes",
  source: "email",
  createdAt: 999_999_999_991,
  modifiedAt: 999_999_999_992,
  serverModifiedAt: 999_999_999_993,
};

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

    // Every column set, and deliberately not 'completed' — 0017
    // rewrites no status, so whatever goes in comes back out.
    const v = FULL_COLUMN_VALUES;
    await env.DB.prepare(
      `INSERT INTO gigs (
         id, user_id, client_id, title, status, location, date_time,
         duration_minutes, calendar_event_id, amount_offered_cents,
         amount_paid_cents, expected_cents, pay_type, hourly_rate_cents,
         work_started_at, work_ended_at, break_minutes, notes, source,
         created_at, modified_at, server_modified_at
       ) VALUES (?, ?, ?, ?, 'cancelled', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        FULL_COLUMN_GIG,
        U1,
        CLIENT,
        v.title,
        v.location,
        v.dateTime,
        v.durationMinutes,
        v.calendarEventId,
        v.amountOfferedCents,
        v.amountPaidCents,
        v.expectedCents,
        v.payType,
        v.hourlyRateCents,
        v.workStartedAt,
        v.workEndedAt,
        v.breakMinutes,
        v.notes,
        v.source,
        v.createdAt,
        v.modifiedAt,
        v.serverModifiedAt,
      )
      .run();

    // One child in each of the four tables that reference gigs.id.
    await env.DB.prepare(
      `INSERT INTO payments (id, user_id, gig_id, amount_cents, created_at, modified_at)
       VALUES (?1, ?2, ?3, ?4, 1000, 1000)`,
    )
      .bind(PAYMENT, U1, COMPLETED, PAYMENT_CENTS)
      .run();
    await env.DB.prepare(
      `INSERT INTO gig_services
         (id, user_id, gig_id, description, amount_offered_cents, payment_id, created_at, modified_at)
       VALUES (?1, ?2, ?3, 'Overtime', ?4, ?5, 1000, 1000)`,
    )
      .bind(SERVICE, U1, COMPLETED, SERVICE_CENTS, PAYMENT)
      .run();
    await env.DB.prepare(
      `INSERT INTO expenses (id, user_id, gig_id, amount_cents, created_at, modified_at)
       VALUES (?1, ?2, ?3, ?4, 1000, 1000)`,
    )
      .bind(EXPENSE, U1, COMPLETED, EXPENSE_CENTS)
      .run();
    await env.DB.prepare(
      `INSERT INTO payment_allocations
         (id, user_id, payment_id, gig_id, amount_cents, created_at, modified_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 1000, 1000)`,
    )
      .bind(ALLOCATION, U1, PAYMENT, COMPLETED, ALLOCATION_CENTS)
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
    // 'paid' specifically. 0015 removed it because paid-ness is derived
    // from payment_allocations, and 0017's header promises it is not
    // coming back. Without this line that promise is only a comment:
    // the route layer's Zod enum rejects 'paid' on its own, so nothing
    // else in the suite would notice the CHECK constraint widening back
    // out underneath it.
    await expect(
      seedGig("10000000-0000-4000-8000-000000000017", "paid"),
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
    // staged and never restored, this is what notices. The amounts are
    // distinct per table, so a restore into the wrong table is caught
    // too, not only a missing row.
    for (const [table, id, amountColumn, amount] of [
      ["payments", PAYMENT, "amount_cents", PAYMENT_CENTS],
      ["gig_services", SERVICE, "amount_offered_cents", SERVICE_CENTS],
      ["expenses", EXPENSE, "amount_cents", EXPENSE_CENTS],
      ["payment_allocations", ALLOCATION, "amount_cents", ALLOCATION_CENTS],
    ] as const) {
      const row = await env.DB.prepare(
        `SELECT gig_id, ${amountColumn} AS amount FROM ${table} WHERE id = ?1`,
      )
        .bind(id)
        .first<{ gig_id: string; amount: number }>();
      expect(row?.gig_id, `${table} lost its row`).toBe(COMPLETED);
      expect(row?.amount, `${table} restored the wrong row`).toBe(amount);
    }
  });

  it("leaves no *_stage table behind", async () => {
    const stage = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%_stage'`,
    ).all<{ name: string }>();
    expect(stage.results).toEqual([]);
  });

  it("passes PRAGMA foreign_key_check", async () => {
    const violations = await env.DB.prepare("PRAGMA foreign_key_check").all();
    expect(violations.results).toEqual([]);
  });

  it("maps every one of the 22 columns correctly, not just the ones the other fixtures set", async () => {
    const row = await env.DB.prepare("SELECT * FROM gigs WHERE id = ?1")
      .bind(FULL_COLUMN_GIG)
      .first<Record<string, unknown>>();
    expect(row).toMatchObject({
      id: FULL_COLUMN_GIG,
      user_id: U1,
      client_id: CLIENT,
      title: FULL_COLUMN_VALUES.title,
      // 0017 rewrites nothing, so this is the value it went in with.
      status: "cancelled",
      location: FULL_COLUMN_VALUES.location,
      date_time: FULL_COLUMN_VALUES.dateTime,
      duration_minutes: FULL_COLUMN_VALUES.durationMinutes,
      calendar_event_id: FULL_COLUMN_VALUES.calendarEventId,
      amount_offered_cents: FULL_COLUMN_VALUES.amountOfferedCents,
      amount_paid_cents: FULL_COLUMN_VALUES.amountPaidCents,
      expected_cents: FULL_COLUMN_VALUES.expectedCents,
      pay_type: FULL_COLUMN_VALUES.payType,
      hourly_rate_cents: FULL_COLUMN_VALUES.hourlyRateCents,
      work_started_at: FULL_COLUMN_VALUES.workStartedAt,
      work_ended_at: FULL_COLUMN_VALUES.workEndedAt,
      break_minutes: FULL_COLUMN_VALUES.breakMinutes,
      notes: FULL_COLUMN_VALUES.notes,
      source: FULL_COLUMN_VALUES.source,
      created_at: FULL_COLUMN_VALUES.createdAt,
      modified_at: FULL_COLUMN_VALUES.modifiedAt,
      server_modified_at: FULL_COLUMN_VALUES.serverModifiedAt,
    });
    // toMatchObject alone would pass even if the row carried EXTRA
    // columns holding wrong values under other names — belt and
    // suspenders on the statement most likely to transpose two adjacent
    // columns.
    expect(Object.keys(row!).sort()).toEqual(
      [
        "amount_offered_cents",
        "amount_paid_cents",
        "break_minutes",
        "calendar_event_id",
        "client_id",
        "created_at",
        "date_time",
        "duration_minutes",
        "expected_cents",
        "hourly_rate_cents",
        "id",
        "location",
        "modified_at",
        "notes",
        "pay_type",
        "server_modified_at",
        "source",
        "status",
        "title",
        "user_id",
        "work_ended_at",
        "work_started_at",
      ].sort(),
    );
  });
});
