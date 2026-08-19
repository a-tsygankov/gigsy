/// <reference types="@cloudflare/vitest-pool-workers" />
/**
 * Migration 0014's backfill, against rows that already existed.
 *
 * Every other suite applies the migrations to an empty database, so the
 * ALTER runs and both UPDATEs touch nothing. That is the wrong shape of
 * test for this statement: it executes exactly once, on live data, and
 * there is no second run to fix a mistake. Hourly pay is already in
 * production, so the rows it has to get right are rows a user typed.
 *
 * This file seeds the pre-0014 schema, applies 0014, and reads back
 * what it wrote. The cases ARE fixtures/gig-pay-vectors.json — the same
 * fixture the module and both its copies are pinned to — so the one-off
 * SQL is held to the numbers expectedCents() produces, not to numbers
 * someone typed into this file while reading the SQL.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import {
  applyMigrationSql,
  EXPECTED_CENTS_MIGRATION,
  MIGRATIONS_BEFORE_EXPECTED_CENTS,
  seedUser,
} from "./helpers/db.ts";
import vectors from "../../fixtures/gig-pay-vectors.json";
import { PAY_TYPES, type PayableGig } from "../src/domain/gig-pay.ts";

const U1 = "backfill-user-1";

/** Deterministic per-case id, so a failure names the case it came from. */
function idFor(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

beforeAll(async () => {
  // Everything up to but NOT including 0014: this is the schema the
  // rows in production were written against.
  await applyMigrationSql(env.DB, MIGRATIONS_BEFORE_EXPECTED_CENTS);
  await seedUser(env.DB, U1);

  // Seeded by raw SQL on purpose. Going through the repo would compute
  // expected_cents on the way in, which is precisely the code path a
  // pre-existing row never took.
  for (const [i, c] of vectors.cases.entries()) {
    const pay = c.gig as PayableGig;
    expect(PAY_TYPES).toContain(pay.payType);
    await env.DB.prepare(
      `INSERT INTO gigs (
         id, user_id, status, pay_type, hourly_rate_cents,
         amount_offered_cents, duration_minutes,
         work_started_at, work_ended_at, break_minutes,
         created_at, modified_at
       ) VALUES (?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, 1, 1)`,
    )
      .bind(
        idFor(i),
        U1,
        pay.payType,
        pay.hourlyRateCents,
        pay.amountOfferedCents,
        pay.durationMinutes,
        pay.workStartedAt,
        pay.workEndedAt,
        pay.breakMinutes,
      )
      .run();
  }

  await applyMigrationSql(env.DB, [EXPECTED_CENTS_MIGRATION]);
});

describe("0014 backfill over rows that predate the column", () => {
  for (const [i, c] of vectors.cases.entries()) {
    it(`backfills: ${c.name}`, async () => {
      const row = await env.DB.prepare(
        "SELECT expected_cents AS e FROM gigs WHERE id = ?",
      )
        .bind(idFor(i))
        .first<{ e: number | null }>();
      expect(row?.e ?? null).toBe(c.expectedCents);
    });
  }

  it("leaves no hourly gig stranded at NULL when it has a figure to state", async () => {
    // The failure this migration had to avoid: a NULL here reads as
    // $0.00 through COALESCE in every aggregate, while the gig row and
    // the CSV fall back to the client derivation and show the real
    // money. Both being wrong together was survivable; disagreeing is
    // not.
    const stranded = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM gigs
       WHERE pay_type = 'hourly'
         AND expected_cents IS NULL
         AND hourly_rate_cents IS NOT NULL
         AND (duration_minutes IS NOT NULL
              OR (work_started_at IS NOT NULL AND work_ended_at IS NOT NULL))`,
    ).first<{ n: number }>();
    expect(stranded?.n).toBe(0);
  });

  it("is not simply copying the offer column", async () => {
    // Guards the whole file: if part 2 were dropped, part 1 alone would
    // still satisfy every fixed case above, and only the hourly rows
    // would quietly go NULL. At least one row must hold a figure its
    // own amount_offered_cents does not.
    const derived = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM gigs
       WHERE expected_cents IS NOT NULL AND amount_offered_cents IS NULL`,
    ).first<{ n: number }>();
    expect(derived?.n).toBeGreaterThan(0);
  });
});
