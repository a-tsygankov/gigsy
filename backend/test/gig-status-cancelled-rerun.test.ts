/// <reference types="@cloudflare/vitest-pool-workers" />
/**
 * Migration 0015's re-runnability, not its data mapping — that half is
 * gig-status-cancelled-migration.test.ts.
 *
 * `d1 migrations apply --local` runs a migration file through
 * db.batch(), one transaction. `--remote` — the one the deploy job
 * actually runs — posts the file to D1's HTTP query endpoint, which
 * Cloudflare does not document as transactional across statements. So
 * "the migration fails partway through" is a real, not hypothetical,
 * state this file can end up in, and the question this suite answers
 * is: does applying the file again from the top recover, and if it
 * can't, does it at least fail loudly instead of destroying data?
 *
 * Each test seeds its own fixture and applies a PREFIX of 0015's
 * statements directly — standing in for a batch that died after that
 * many — then applies the whole file again and inspects what survived.
 * A separate file from the mapping tests on purpose: that file's
 * beforeAll already runs 0015 to completion once, which leaves no
 * pre-0015 schema left to retry against.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import {
  applyMigrationSql,
  MIGRATIONS_BEFORE_STATUS_CANCELLED,
  STATUS_CANCELLED_MIGRATION,
  splitMigrationStatements,
  seedUser,
} from "./helpers/db.ts";

const U1 = "status-rerun-user-1";

/** Every statement in 0015 up to and including the first one that
 *  matches `matches` — a retry-injection point named by content, not
 *  by a magic statement count that would silently go stale the moment
 *  someone reorders the file. */
function statementsThrough(
  sql: string,
  matches: (stmt: string) => boolean,
): string[] {
  const all = splitMigrationStatements(sql);
  const idx = all.findIndex(matches);
  if (idx === -1) throw new Error("no statement in 0015 matched — file changed?");
  return all.slice(0, idx + 1);
}

/** The three stage tables created and the three children cleared —
 *  nothing about gigs touched yet. */
const THROUGH_CHILDREN_CLEARED = statementsThrough(
  STATUS_CANCELLED_MIGRATION,
  (s) => s === "DELETE FROM expenses",
);

/** gigs_new built and populated; the old gigs table still exists. */
const THROUGH_GIGS_NEW_POPULATED = statementsThrough(
  STATUS_CANCELLED_MIGRATION,
  (s) => s.includes("INSERT INTO gigs_new"),
);

/** The dangerous window: gigs is gone, gigs_new not yet renamed. */
const THROUGH_GIGS_DROPPED = statementsThrough(
  STATUS_CANCELLED_MIGRATION,
  (s) => s === "DROP TABLE IF EXISTS gigs",
);

async function runStatements(stmts: readonly string[]): Promise<void> {
  for (const stmt of stmts) {
    await env.DB.prepare(stmt).run();
  }
}

/** One gig plus a payment, a service and an expense hanging off it —
 *  enough to prove both the status mapping and the FK-safe staging
 *  survive a retry, not just the gig row by itself. */
async function seedFixture(id: string, status: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO gigs (id, user_id, status, created_at, modified_at)
     VALUES (?, ?, ?, 1, 1)`,
  )
    .bind(id, U1, status)
    .run();
  await env.DB.prepare(
    `INSERT INTO payments (id, user_id, gig_id, amount_cents, created_at, modified_at)
     VALUES (?, ?, ?, 5000, 1, 1)`,
  )
    .bind(`${id}-pay`, U1, id)
    .run();
  await env.DB.prepare(
    `INSERT INTO gig_services
       (id, user_id, gig_id, description, amount_offered_cents, payment_id, created_at, modified_at)
     VALUES (?, ?, ?, 'Extra', 1000, ?, 1, 1)`,
  )
    .bind(`${id}-svc`, U1, id, `${id}-pay`)
    .run();
  await env.DB.prepare(
    `INSERT INTO expenses (id, user_id, gig_id, amount_cents, created_at, modified_at)
     VALUES (?, ?, ?, 500, 1, 1)`,
  )
    .bind(`${id}-exp`, U1, id)
    .run();
}

beforeAll(async () => {
  // Stops before 0015 on purpose — every test in this file applies it
  // (or a prefix of it) itself.
  await applyMigrationSql(env.DB, MIGRATIONS_BEFORE_STATUS_CANCELLED);
  await seedUser(env.DB, U1);
});

describe("re-running 0015 after a simulated partial failure", () => {
  it("applying the whole file twice in a row is a safe no-op", async () => {
    const id = "70000000-0000-4000-8000-000000000001";
    await seedFixture(id, "paid");

    await applyMigrationSql(env.DB, [STATUS_CANCELLED_MIGRATION]);
    await applyMigrationSql(env.DB, [STATUS_CANCELLED_MIGRATION]);

    const gig = await env.DB.prepare("SELECT status FROM gigs WHERE id = ?")
      .bind(id)
      .first<{ status: string }>();
    expect(gig?.status).toBe("completed");

    const counts = await env.DB.batch([
      env.DB.prepare("SELECT COUNT(*) AS n FROM gigs WHERE user_id = ?").bind(U1),
      env.DB.prepare("SELECT COUNT(*) AS n FROM payments WHERE user_id = ?").bind(U1),
      env.DB.prepare("SELECT COUNT(*) AS n FROM gig_services WHERE user_id = ?").bind(
        U1,
      ),
      env.DB.prepare("SELECT COUNT(*) AS n FROM expenses WHERE user_id = ?").bind(U1),
    ]);
    for (const c of counts) {
      expect((c.results[0] as { n: number }).n).toBe(1);
    }
  });

  it("recovers cleanly from a failure right after the children are cleared", async () => {
    const id = "70000000-0000-4000-8000-000000000002";
    await seedFixture(id, "lead");

    await runStatements(THROUGH_CHILDREN_CLEARED);
    await applyMigrationSql(env.DB, [STATUS_CANCELLED_MIGRATION]);

    const gig = await env.DB.prepare("SELECT status FROM gigs WHERE id = ?")
      .bind(id)
      .first<{ status: string }>();
    expect(gig?.status).toBe("lead");
    const payment = await env.DB.prepare(
      "SELECT gig_id FROM payments WHERE id = ?",
    )
      .bind(`${id}-pay`)
      .first<{ gig_id: string }>();
    expect(payment?.gig_id).toBe(id);
  });

  it("recovers cleanly from a failure right after gigs_new is populated", async () => {
    const id = "70000000-0000-4000-8000-000000000003";
    await seedFixture(id, "confirmed");

    await runStatements(THROUGH_GIGS_NEW_POPULATED);
    // The unfinished attempt leaves gigs_new holding one correct row —
    // re-running must not try to insert it a second time and trip the
    // primary key.
    await applyMigrationSql(env.DB, [STATUS_CANCELLED_MIGRATION]);

    const gig = await env.DB.prepare("SELECT status FROM gigs WHERE id = ?")
      .bind(id)
      .first<{ status: string }>();
    expect(gig?.status).toBe("confirmed");
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM gigs WHERE id = ?",
    )
      .bind(id)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("leaves the stage tables behind nowhere once fully recovered", async () => {
    const id = "70000000-0000-4000-8000-000000000004";
    await seedFixture(id, "completed");

    await runStatements(THROUGH_CHILDREN_CLEARED);
    await applyMigrationSql(env.DB, [STATUS_CANCELLED_MIGRATION]);

    const stage = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%_stage'`,
    ).all<{ name: string }>();
    expect(stage.results).toEqual([]);
  });

  it("passes PRAGMA foreign_key_check once fully recovered", async () => {
    const id = "70000000-0000-4000-8000-000000000005";
    await seedFixture(id, "paid");

    await runStatements(THROUGH_GIGS_NEW_POPULATED);
    await applyMigrationSql(env.DB, [STATUS_CANCELLED_MIGRATION]);

    const violations = await env.DB.prepare("PRAGMA foreign_key_check").all();
    expect(violations.results).toEqual([]);
  });

  /**
   * The window that does NOT self-heal, proven rather than asserted:
   * once gigs is dropped and before the rename, gigs_new — already
   * fully populated and correct — is the only copy of the migrated
   * data. A retry's own "INSERT INTO gigs_new ... FROM gigs" needs a
   * table named gigs to read from, and there isn't one, so the retry
   * fails outright. What matters is what it does NOT do: nothing in
   * 0015 ever drops or overwrites gigs_new, so the one correct copy is
   * still sitting there, untouched, after the failed retry — a blocked
   * deploy, not a lost gig.
   */
  it("fails loudly on retry once gigs is dropped, without losing gigs_new's data", async () => {
    const id = "70000000-0000-4000-8000-000000000006";
    await seedFixture(id, "paid");

    await runStatements(THROUGH_GIGS_DROPPED);

    await expect(
      applyMigrationSql(env.DB, [STATUS_CANCELLED_MIGRATION]),
    ).rejects.toThrow(/no such table: main\.gigs\b/);

    // Not lost: the fully-migrated row is still sitting in gigs_new,
    // exactly where the doomed retry left it untouched.
    const row = await env.DB.prepare(
      "SELECT status FROM gigs_new WHERE id = ?",
    )
      .bind(id)
      .first<{ status: string }>();
    expect(row?.status).toBe("completed");
  });
});
