/// <reference types="@cloudflare/vitest-pool-workers" />
/**
 * Migration 0017's re-runnability, not what it maps — that half is
 * gig-status-delivered-migration.test.ts.
 *
 * `d1 migrations apply --local` runs a migration file through
 * db.batch(), one transaction. `--remote` — the one the deploy job
 * actually runs — posts the file to D1's HTTP query endpoint, which
 * Cloudflare does not document as transactional across statements. So
 * "the migration died partway through" is a real state this file can
 * end up in, and the question here is whether applying it again from
 * the top recovers, and where it cannot, whether it fails loudly
 * instead of destroying data.
 *
 * Each test seeds its own fixture, applies a PREFIX of 0017's
 * statements directly — standing in for a batch that died after that
 * many — then applies the whole file again and inspects what survived.
 * Separate from the mapping tests on purpose: that file's beforeAll
 * already runs 0017 to completion, leaving no pre-0017 schema to retry
 * against.
 *
 * Every fixture carries a child in ALL FOUR tables that hold a foreign
 * key into gigs.id, payment_allocations included — the table 0015
 * never had to stage and so the one a retry is most likely to drop.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import {
  applyMigrationSql,
  MIGRATIONS_BEFORE_DELIVERED_STATUS,
  DELIVERED_STATUS_MIGRATION,
  splitMigrationStatements,
  seedUser,
} from "./helpers/db.ts";

const U1 = "delivered-rerun-user-1";

/** Every statement in 0017 up to and including the first one that
 *  matches `matches` — a retry-injection point named by content, not
 *  by a magic statement count that would go stale the moment someone
 *  reorders the file. */
function statementsThrough(
  sql: string,
  matches: (stmt: string) => boolean,
): string[] {
  const all = splitMigrationStatements(sql);
  const idx = all.findIndex(matches);
  if (idx === -1) {
    throw new Error("no statement in 0017 matched — file changed?");
  }
  return all.slice(0, idx + 1);
}

/** The four stage tables created and all four children cleared —
 *  nothing about gigs touched yet. */
const THROUGH_CHILDREN_CLEARED = statementsThrough(
  DELIVERED_STATUS_MIGRATION,
  (s) => s === "DELETE FROM expenses",
);

/** gigs_new built and populated; the old gigs table still exists. */
const THROUGH_GIGS_NEW_POPULATED = statementsThrough(
  DELIVERED_STATUS_MIGRATION,
  (s) => s.includes("INSERT INTO gigs_new"),
);

/** The window that cannot self-heal: gigs is gone, gigs_new not yet
 *  renamed, and the four children are still empty. */
const THROUGH_GIGS_DROPPED = statementsThrough(
  DELIVERED_STATUS_MIGRATION,
  (s) => s === "DROP TABLE IF EXISTS gigs",
);

/** One statement past that window — the rebuild is done and named
 *  `gigs`, but not one of the four children has been restored yet, so
 *  every child row in the database exists ONLY in a stage table. The
 *  worst survivable moment to lose the connection. */
const THROUGH_GIGS_RENAMED = statementsThrough(
  DELIVERED_STATUS_MIGRATION,
  (s) => s === "ALTER TABLE gigs_new RENAME TO gigs",
);

async function runStatements(stmts: readonly string[]): Promise<void> {
  for (const stmt of stmts) {
    await env.DB.prepare(stmt).run();
  }
}

/** A gig plus one child in each of the four tables that reference
 *  gigs.id. gig_services.payment_id and payment_allocations.payment_id
 *  both point at the payment as well, which is what makes the clearing
 *  and restoring ORDER matter and not merely the set of tables. */
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
  await env.DB.prepare(
    `INSERT INTO payment_allocations
       (id, user_id, payment_id, gig_id, amount_cents, created_at, modified_at)
     VALUES (?, ?, ?, ?, 2500, 1, 1)`,
  )
    .bind(`${id}-alloc`, U1, `${id}-pay`, id)
    .run();
}

/** Every child row of `id` is back and still points at it. Each table's
 *  amount is distinct, so a restore that put the right number of rows
 *  into the wrong table is caught too, not just a missing one. */
async function expectChildrenIntact(id: string): Promise<void> {
  for (const [table, childId, amountColumn, amount] of [
    ["payments", `${id}-pay`, "amount_cents", 5000],
    ["gig_services", `${id}-svc`, "amount_offered_cents", 1000],
    ["expenses", `${id}-exp`, "amount_cents", 500],
    ["payment_allocations", `${id}-alloc`, "amount_cents", 2500],
  ] as const) {
    const row = await env.DB.prepare(
      `SELECT gig_id, ${amountColumn} AS amount FROM ${table} WHERE id = ?`,
    )
      .bind(childId)
      .first<{ gig_id: string; amount: number }>();
    expect(row?.gig_id, `${table} lost its row`).toBe(id);
    expect(row?.amount, `${table} restored the wrong row`).toBe(amount);
  }
}

async function expectNoStageTables(): Promise<void> {
  const stage = await env.DB.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%_stage'`,
  ).all<{ name: string }>();
  expect(stage.results).toEqual([]);
}

beforeAll(async () => {
  // Stops before 0017 on purpose — every test applies it (or a prefix
  // of it) itself.
  await applyMigrationSql(env.DB, MIGRATIONS_BEFORE_DELIVERED_STATUS);
  await seedUser(env.DB, U1);
});

describe("re-running 0017 after a simulated partial failure", () => {
  it("applying the whole file twice in a row is a safe no-op", async () => {
    const id = "80000000-0000-4000-8000-000000000001";
    await seedFixture(id, "completed");

    await applyMigrationSql(env.DB, [DELIVERED_STATUS_MIGRATION]);
    await applyMigrationSql(env.DB, [DELIVERED_STATUS_MIGRATION]);

    const gig = await env.DB.prepare("SELECT status FROM gigs WHERE id = ?")
      .bind(id)
      .first<{ status: string }>();
    expect(gig?.status).toBe("completed");

    const counts = await env.DB.batch([
      env.DB.prepare("SELECT COUNT(*) AS n FROM gigs WHERE user_id = ?").bind(U1),
      env.DB.prepare("SELECT COUNT(*) AS n FROM payments WHERE user_id = ?").bind(
        U1,
      ),
      env.DB.prepare(
        "SELECT COUNT(*) AS n FROM gig_services WHERE user_id = ?",
      ).bind(U1),
      env.DB.prepare("SELECT COUNT(*) AS n FROM expenses WHERE user_id = ?").bind(
        U1,
      ),
      env.DB.prepare(
        "SELECT COUNT(*) AS n FROM payment_allocations WHERE user_id = ?",
      ).bind(U1),
    ]);
    for (const c of counts) {
      expect((c.results[0] as { n: number }).n).toBe(1);
    }
    await expectChildrenIntact(id);
    await expectNoStageTables();
  });

  it("recovers from a failure right after the four children are cleared", async () => {
    const id = "80000000-0000-4000-8000-000000000002";
    await seedFixture(id, "lead");

    await runStatements(THROUGH_CHILDREN_CLEARED);
    await applyMigrationSql(env.DB, [DELIVERED_STATUS_MIGRATION]);

    const gig = await env.DB.prepare("SELECT status FROM gigs WHERE id = ?")
      .bind(id)
      .first<{ status: string }>();
    expect(gig?.status).toBe("lead");
    await expectChildrenIntact(id);
    await expectNoStageTables();
  });

  it("recovers from a failure right after gigs_new is populated", async () => {
    const id = "80000000-0000-4000-8000-000000000003";
    await seedFixture(id, "cancelled");

    await runStatements(THROUGH_GIGS_NEW_POPULATED);
    // The unfinished attempt left gigs_new holding one correct row —
    // re-running must not insert it a second time and trip the primary
    // key.
    await applyMigrationSql(env.DB, [DELIVERED_STATUS_MIGRATION]);

    const gig = await env.DB.prepare("SELECT status FROM gigs WHERE id = ?")
      .bind(id)
      .first<{ status: string }>();
    expect(gig?.status).toBe("cancelled");
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM gigs WHERE id = ?",
    )
      .bind(id)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
    await expectChildrenIntact(id);
  });

  /**
   * The cut this task asks for: PAST the DROP, at the one moment where
   * every child row in the database exists only inside a stage table
   * and the rebuilt gigs has no children hanging off it at all. A retry
   * from the top has to notice the stage tables are already there —
   * CREATE TABLE IF NOT EXISTS ... AS SELECT would otherwise overwrite
   * them with the empty children and lose all four rows for good —
   * rebuild gigs a second time from itself, and restore from the stage
   * copies it inherited.
   */
  it("completes on retry after gigs is dropped and renamed, with the children still only in the stage tables", async () => {
    const id = "80000000-0000-4000-8000-000000000004";
    await seedFixture(id, "confirmed");

    await runStatements(THROUGH_GIGS_RENAMED);

    // The precondition of this scenario, asserted rather than assumed:
    // the real children are gone from their own tables at this point.
    const stranded = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM payment_allocations",
    ).first<{ n: number }>();
    expect(stranded?.n).toBe(0);

    await applyMigrationSql(env.DB, [DELIVERED_STATUS_MIGRATION]);

    const gig = await env.DB.prepare("SELECT status FROM gigs WHERE id = ?")
      .bind(id)
      .first<{ status: string }>();
    expect(gig?.status).toBe("confirmed");
    await expectChildrenIntact(id);
    await expectNoStageTables();

    const violations = await env.DB.prepare("PRAGMA foreign_key_check").all();
    expect(violations.results).toEqual([]);

    // And the point of the whole migration actually landed.
    await env.DB.prepare(
      `INSERT INTO gigs (id, user_id, status, created_at, modified_at)
       VALUES (?, ?, 'delivered', 1, 1)`,
    )
      .bind("80000000-0000-4000-8000-00000000000d", U1)
      .run();
  });

  /**
   * The window that does NOT self-heal, proven rather than asserted:
   * between DROP TABLE gigs and the rename, gigs_new — already fully
   * populated and correct — is the only copy of the migrated data. A
   * retry's own "INSERT INTO gigs_new ... FROM gigs" needs a table
   * named gigs to read from and there is not one, so it fails outright.
   * What matters is what it does NOT do: nothing in 0017 drops or
   * overwrites gigs_new, and all four stage tables are created with IF
   * NOT EXISTS, so both the gig and its child rows are still there
   * after the failed retry — a blocked deploy, not a lost gig.
   */
  it("fails loudly on retry inside the drop/rename window, without losing gigs_new or the staged children", async () => {
    const id = "80000000-0000-4000-8000-000000000005";
    await seedFixture(id, "completed");

    await runStatements(THROUGH_GIGS_DROPPED);

    await expect(
      applyMigrationSql(env.DB, [DELIVERED_STATUS_MIGRATION]),
    ).rejects.toThrow(/no such table: main\.gigs\b/);

    const row = await env.DB.prepare("SELECT status FROM gigs_new WHERE id = ?")
      .bind(id)
      .first<{ status: string }>();
    expect(row?.status).toBe("completed");

    for (const [table, childId] of [
      ["payments_stage", `${id}-pay`],
      ["gig_services_stage", `${id}-svc`],
      ["expenses_stage", `${id}-exp`],
      ["payment_allocations_stage", `${id}-alloc`],
    ] as const) {
      const staged = await env.DB.prepare(
        `SELECT gig_id FROM ${table} WHERE id = ?`,
      )
        .bind(childId)
        .first<{ gig_id: string }>();
      expect(staged?.gig_id, `${table} was overwritten by the retry`).toBe(id);
    }
  });
});
