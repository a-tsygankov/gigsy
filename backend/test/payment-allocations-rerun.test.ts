/// <reference types="@cloudflare/vitest-pool-workers" />
/**
 * Migration 0016's re-runnability, not its data mapping — that half is
 * payment-allocations-backfill.test.ts.
 *
 * `d1 migrations apply --local` runs a migration file through
 * db.batch(), one transaction. `--remote` — the one the deploy job
 * actually runs — posts the file to D1's HTTP query endpoint, which
 * Cloudflare does not document as transactional across statements (the
 * same gap 0015's header explains, and this file follows
 * gig-status-cancelled-rerun.test.ts's pattern for exercising it). So
 * "the migration fails partway through" is a real, not hypothetical,
 * state 0016 can end up in, and these tests answer: does re-applying it
 * from the top recover, and where it can't, does it at least fail
 * loudly instead of silently duplicating every allocation and doubling
 * every gig's paid total?
 *
 * Each test seeds its own fixture and applies a PREFIX of 0016's
 * statements directly — standing in for a batch that died after that
 * many — then applies the whole file (or, for the guarded INSERT
 * itself, just that one statement) again and inspects what survived.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import {
  applyMigrationSql,
  MIGRATIONS_BEFORE_PAYMENT_ALLOCATIONS,
  PAYMENT_ALLOCATIONS_MIGRATION,
  splitMigrationStatements,
  seedUser,
} from "./helpers/db.ts";

const U1 = "alloc-rerun-user-1";

/** Every statement in 0016 up to and including the first one that
 *  matches `matches` — a retry-injection point named by content, not by
 *  a magic statement count that would silently go stale the moment
 *  someone reorders the file. */
function statementsThrough(
  sql: string,
  matches: (stmt: string) => boolean,
): string[] {
  const all = splitMigrationStatements(sql);
  const idx = all.findIndex(matches);
  if (idx === -1) throw new Error("no statement in 0016 matched — file changed?");
  return all.slice(0, idx + 1);
}

/** The table and its first index only — exactly the partial state used
 *  to demonstrate the pre-fix bug: a plain re-run aborted here with
 *  "table payment_allocations already exists" before anything else in
 *  the file ran. */
const THROUGH_FIRST_INDEX = statementsThrough(PAYMENT_ALLOCATIONS_MIGRATION, (s) =>
  s.startsWith("CREATE INDEX") && s.includes("idx_payment_allocations_user "),
);

/** Table, all five indexes and the client_id column added — the one
 *  statement in this file with no conditional form. */
const THROUGH_ALTER_TABLE = statementsThrough(PAYMENT_ALLOCATIONS_MIGRATION, (s) =>
  s.startsWith("ALTER TABLE payments ADD COLUMN"),
);

/** Everything through the backfill INSERT — the point a human-assisted
 *  resume would reach after skipping the ALTER statement by hand. */
const THROUGH_BACKFILL_INSERT = statementsThrough(PAYMENT_ALLOCATIONS_MIGRATION, (s) =>
  s.startsWith("INSERT INTO payment_allocations"),
);

const backfillInsertStatement = THROUGH_BACKFILL_INSERT[
  THROUGH_BACKFILL_INSERT.length - 1
]!;

async function runStatements(stmts: readonly string[]): Promise<void> {
  for (const stmt of stmts) {
    await env.DB.prepare(stmt).run();
  }
}

async function seedFixture(id: string, amountCents: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO clients (id, user_id, name, created_at, modified_at)
     VALUES (?, ?, 'Rerun Client', 1, 1)`,
  )
    .bind(`${id}-client`, U1)
    .run();
  await env.DB.prepare(
    `INSERT INTO gigs (id, user_id, client_id, status, created_at, modified_at)
     VALUES (?, ?, ?, 'completed', 1, 1)`,
  )
    .bind(`${id}-gig`, U1, `${id}-client`)
    .run();
  await env.DB.prepare(
    `INSERT INTO payments (id, user_id, gig_id, amount_cents, created_at, modified_at)
     VALUES (?, ?, ?, ?, 1, 1)`,
  )
    .bind(`${id}-pay`, U1, `${id}-gig`, amountCents)
    .run();
}

beforeAll(async () => {
  // Stops before 0016 on purpose — every test in this file applies it
  // (or a prefix of it) itself.
  await applyMigrationSql(env.DB, MIGRATIONS_BEFORE_PAYMENT_ALLOCATIONS);
  await seedUser(env.DB, U1);
});

describe("re-running 0016 after a simulated partial failure", () => {
  /**
   * Unlike 0015 (a full drop-and-rebuild, entirely guarded), applying
   * the whole 0016 file twice back to back is NOT a safe no-op — this
   * is the one place that framing from 0015's rerun suite does not
   * carry over, proven here rather than assumed. The ALTER TABLE has no
   * conditional form, so the second pass fails there every time, even
   * though the first pass fully succeeded. What the fix guarantees
   * instead is that the failure is loud and nothing already written
   * gets touched again.
   */
  it("applying the whole file a second time after a full success fails at the ALTER, without touching what the first pass wrote", async () => {
    const id = "80000000-0000-4000-8000-000000000001";
    await seedFixture(id, 5000);

    await applyMigrationSql(env.DB, [PAYMENT_ALLOCATIONS_MIGRATION]);
    await expect(
      applyMigrationSql(env.DB, [PAYMENT_ALLOCATIONS_MIGRATION]),
    ).rejects.toThrow(/duplicate column name: client_id/);

    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM payment_allocations WHERE payment_id = ?",
    )
      .bind(`${id}-pay`)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);

    const gig = await env.DB.prepare(
      "SELECT amount_paid_cents FROM gigs WHERE id = ?",
    )
      .bind(`${id}-gig`)
      .first<{ amount_paid_cents: number }>();
    expect(gig?.amount_paid_cents).toBe(5000);
  });

  it("recovers cleanly from a failure right after the table and first index — the exact case that used to abort at statement 1", async () => {
    const id = "80000000-0000-4000-8000-000000000002";
    await seedFixture(id, 6000);

    await runStatements(THROUGH_FIRST_INDEX);
    // Before the IF NOT EXISTS / NOT EXISTS fix, this threw "table
    // payment_allocations already exists" and never reached the ALTER,
    // the backfill INSERT or either UPDATE.
    await applyMigrationSql(env.DB, [PAYMENT_ALLOCATIONS_MIGRATION]);

    const alloc = await env.DB.prepare(
      "SELECT amount_cents FROM payment_allocations WHERE payment_id = ?",
    )
      .bind(`${id}-pay`)
      .first<{ amount_cents: number }>();
    expect(alloc?.amount_cents).toBe(6000);

    const gig = await env.DB.prepare(
      "SELECT amount_paid_cents FROM gigs WHERE id = ?",
    )
      .bind(`${id}-gig`)
      .first<{ amount_paid_cents: number }>();
    expect(gig?.amount_paid_cents).toBe(6000);

    const payment = await env.DB.prepare(
      "SELECT client_id FROM payments WHERE id = ?",
    )
      .bind(`${id}-pay`)
      .first<{ client_id: string }>();
    expect(payment?.client_id).toBe(`${id}-client`);
  });

  /**
   * The window that does NOT self-heal, proven rather than asserted:
   * `ALTER TABLE ADD COLUMN` has no conditional form in SQLite (a
   * literal `ADD COLUMN IF NOT EXISTS` was checked directly against
   * this D1 instance and rejected as a syntax error). Once that
   * statement has run, a retry of the whole file fails there — after
   * the now-idempotent CREATE TABLE and five indexes have silently
   * no-op'd, before the backfill INSERT or either UPDATE gets to run
   * again. What matters is that the failure is loud and nothing is
   * duplicated, not that it recovers automatically — it can't.
   */
  it("fails loudly on retry once the column has been added, without touching payment_allocations", async () => {
    const id = "80000000-0000-4000-8000-000000000003";
    await seedFixture(id, 7000);

    await runStatements(THROUGH_ALTER_TABLE);

    await expect(
      applyMigrationSql(env.DB, [PAYMENT_ALLOCATIONS_MIGRATION]),
    ).rejects.toThrow(/duplicate column name: client_id/);

    // The retry died before the backfill INSERT ever ran a second time
    // (it hadn't even run a first time at this injection point) — nothing
    // to have duplicated.
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM payment_allocations WHERE payment_id = ?",
    )
      .bind(`${id}-pay`)
      .first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("a human-assisted resume that re-runs just the backfill INSERT does not duplicate the allocation", async () => {
    const id = "80000000-0000-4000-8000-000000000004";
    await seedFixture(id, 4000);

    // Simulates a human noticing the ALTER already succeeded, skipping
    // it by hand, and re-running the rest of the file from the backfill
    // INSERT onward — the scenario the NOT EXISTS guard exists for.
    await runStatements(THROUGH_BACKFILL_INSERT);
    await env.DB.prepare(backfillInsertStatement).run();

    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM payment_allocations WHERE payment_id = ?",
    )
      .bind(`${id}-pay`)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("passes PRAGMA foreign_key_check once fully recovered", async () => {
    const id = "80000000-0000-4000-8000-000000000005";
    await seedFixture(id, 3000);

    await runStatements(THROUGH_FIRST_INDEX);
    await applyMigrationSql(env.DB, [PAYMENT_ALLOCATIONS_MIGRATION]);

    const violations = await env.DB.prepare("PRAGMA foreign_key_check").all();
    expect(violations.results).toEqual([]);
  });
});
