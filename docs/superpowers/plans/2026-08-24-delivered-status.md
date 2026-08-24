# `delivered` Gig Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `delivered` as a fifth gig lifecycle status, between `completed` and payment, without changing what a gig is owed or whether its time is spoken for.

**Architecture:** Migration `0017` widens the `gigs.status` CHECK constraint by rebuilding the table (SQLite cannot ALTER a CHECK), staging the four tables that hold a foreign key into `gigs.id`. Both packages' `GIG_STATUSES` gain the value, and every one of six places that tests for `completed` is widened to include `delivered`. `StatusPill` gets a new teal hue, added to the curated palette.

**Tech Stack:** Cloudflare D1 (SQLite), Drizzle, Hono, Vitest with `@cloudflare/vitest-pool-workers`, React 18, Tailwind with a token-driven palette.

**Spec:** `docs/superpowers/specs/2026-08-23-delivered-status-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `backend/migrations/0017_gig_status_delivered.sql` | **Create.** The rebuild-and-swap. |
| `backend/test/helpers/db.ts` | **Modify.** Import 0017; add `MIGRATIONS_BEFORE_DELIVERED_STATUS` / `DELIVERED_STATUS_MIGRATION`; extend `MIGRATIONS`. |
| `backend/test/gig-status-delivered-migration.test.ts` | **Create.** 0017 against a database with FK children in all four tables. |
| `backend/test/gig-status-delivered-rerun.test.ts` | **Create.** 0017 re-applied after a partial batch. |
| `backend/src/db/schema.ts` | **Modify.** `GIG_STATUSES`. |
| `webapp/src/lib/types.ts` | **Modify.** `GigStatus` + `GIG_STATUSES`. |
| `backend/test/gig-status-enum.test.ts` | **Create.** The two lists must not drift. |
| `backend/src/services/dashboard.ts` | **Modify.** Two `completed` queries; add the completed-not-delivered count. |
| `backend/src/services/reports.ts` | **Modify.** `owedCents`. |
| `backend/src/services/availability.ts` | **Modify.** `BUSY_STATUSES`. |
| `backend/src/push/nudges.ts` | **Modify.** The unpaid nudge query. |
| `webapp/src/screens/ClientEdit.tsx` | **Modify.** Both history groups. |
| `webapp/src/styles/tokens/colors.css` | **Modify.** Teal tokens, both theme blocks. |
| `webapp/tailwind.config.ts` | **Modify.** Expose the teal scale. |
| `webapp/src/components/StatusPill.tsx` | **Modify.** The `delivered` entry, and the stale docblock. |
| `webapp/src/help/scenarios/record-work.ts` | **Modify.** Stale lifecycle prose. |
| `webapp/src/screens/Dashboard.tsx` | **Modify.** The second drill-down tile. |

**Do not** re-add `paid` as a status, and **do not** drop `cancelled`. See the spec's "A correction to the source document".

---

### Task 1: Migration 0017 — widen the constraint

The riskiest task. Read `backend/migrations/0015_gig_status_cancelled.sql` in full before starting; this is that migration's shape with a fourth FK table added.

**Files:**
- Create: `backend/migrations/0017_gig_status_delivered.sql`
- Modify: `backend/test/helpers/db.ts`
- Test: `backend/test/gig-status-delivered-migration.test.ts`

- [ ] **Step 1: Write the migration**

Create `backend/migrations/0017_gig_status_delivered.sql`:

```sql
-- 'delivered' joins the lifecycle, between 'completed' and payment.
--
-- For work whose output is handed over separately from the job being
-- finished, 'completed' had to mean both "I finished" and "the client
-- has it". This splits them.
--
-- 'paid' is NOT re-added. Migration 0015 removed it because paid-ness
-- is derived from payment_allocations (domain/gig-pay.ts), and a
-- hand-set status beside a payment record is two sources of truth for
-- one fact. 'cancelled' stays, for the same reason it was added.
--
-- 'delivered' is NOT sequence-enforced against payment: a deposit can
-- clear before delivery and a balance after, so the server permits any
-- order.
--
-- WHY A REBUILD: `status` carries a CHECK constraint hardcoded in
-- 0000_init.sql and rewritten by 0015. SQLite has no ALTER TABLE for a
-- CHECK, so widening it means a copy carrying the new constraint, every
-- row moved across with columns named explicitly on BOTH sides, the old
-- table dropped, the copy renamed in. Naming columns explicitly is what
-- makes this safe against the physical column order that 0006, 0008,
-- 0011, 0013 and 0014's ALTER TABLE ADD COLUMNs actually left behind.
--
-- HARDER THAN 0015: four tables now hold a foreign key into gigs.id —
-- expenses (0000), gig_services and payments (0002), and
-- payment_allocations (0016). 0015 handled three; the fourth is new.
-- D1 enforces foreign keys inside migrations (PRAGMA foreign_keys=off
-- is accepted and silently ignored, and PRAGMA defer_foreign_keys does
-- not survive between statements — both established against this D1
-- instance in 0015's header). DROP TABLE performs an implicit DELETE
-- FROM first, refused the instant any child still points at a row
-- about to disappear. So all four stage, empty, and restore.
--
-- NOTHING IS BACKFILLED. Unlike 0015, which rewrote 'paid' rows, this
-- only widens what is permitted. Every gig keeps the status it had.
CREATE TABLE IF NOT EXISTS payment_allocations_stage AS SELECT * FROM payment_allocations;
CREATE TABLE IF NOT EXISTS gig_services_stage AS SELECT * FROM gig_services;
CREATE TABLE IF NOT EXISTS payments_stage AS SELECT * FROM payments;
CREATE TABLE IF NOT EXISTS expenses_stage AS SELECT * FROM expenses;

-- Dependency order, children first: payment_allocations references
-- both payments and gigs, gig_services references both payments and
-- gigs, so both must go before payments. Deleting from an
-- already-empty table (a retry's second pass) is a harmless no-op.
DELETE FROM payment_allocations;
DELETE FROM gig_services;
DELETE FROM payments;
DELETE FROM expenses;

CREATE TABLE IF NOT EXISTS gigs_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  client_id TEXT REFERENCES clients(id),
  title TEXT,
  status TEXT NOT NULL DEFAULT 'lead'
    CHECK (status IN ('lead','confirmed','completed','delivered','cancelled')),
  location TEXT,
  date_time INTEGER,
  duration_minutes INTEGER,
  calendar_event_id TEXT,
  amount_offered_cents INTEGER,
  amount_paid_cents INTEGER,
  expected_cents INTEGER,
  pay_type TEXT NOT NULL DEFAULT 'fixed',
  hourly_rate_cents INTEGER,
  work_started_at INTEGER,
  work_ended_at INTEGER,
  break_minutes INTEGER,
  notes TEXT,
  source TEXT,
  created_at INTEGER NOT NULL,
  modified_at INTEGER NOT NULL,
  server_modified_at INTEGER NOT NULL DEFAULT 0
);

-- The NOT IN filter is what makes this statement re-runnable: a retry
-- reaching here with gigs_new already partly populated copies only the
-- rows it has not already copied, rather than erroring on a duplicate
-- primary key. No CASE on status — nothing is rewritten here.
INSERT INTO gigs_new (
  id, user_id, client_id, title, status, location, date_time,
  duration_minutes, calendar_event_id, amount_offered_cents,
  amount_paid_cents, expected_cents, pay_type, hourly_rate_cents,
  work_started_at, work_ended_at, break_minutes, notes, source,
  created_at, modified_at, server_modified_at
)
SELECT
  id, user_id, client_id, title, status, location, date_time,
  duration_minutes, calendar_event_id, amount_offered_cents,
  amount_paid_cents, expected_cents, pay_type, hourly_rate_cents,
  work_started_at, work_ended_at, break_minutes, notes, source,
  created_at, modified_at, server_modified_at
FROM gigs
WHERE id NOT IN (SELECT id FROM gigs_new);

DROP TABLE IF EXISTS gigs;
ALTER TABLE gigs_new RENAME TO gigs;

CREATE INDEX IF NOT EXISTS idx_gigs_user_date ON gigs(user_id, date_time);
CREATE INDEX IF NOT EXISTS idx_gigs_user_status ON gigs(user_id, status);
CREATE INDEX IF NOT EXISTS idx_gigs_client ON gigs(client_id);
CREATE INDEX IF NOT EXISTS idx_gigs_user_server_modified ON gigs(user_id, server_modified_at);

-- Restore in reverse dependency order: parents before children.
-- payments before both gig_services and payment_allocations, since
-- both reference it. Always running into a table emptied in this same
-- pass, so no NOT-IN filter is needed the way it is for gigs_new.
INSERT INTO expenses SELECT * FROM expenses_stage;
INSERT INTO payments SELECT * FROM payments_stage;
INSERT INTO gig_services SELECT * FROM gig_services_stage;
INSERT INTO payment_allocations SELECT * FROM payment_allocations_stage;

DROP TABLE IF EXISTS payment_allocations_stage;
DROP TABLE IF EXISTS gig_services_stage;
DROP TABLE IF EXISTS payments_stage;
DROP TABLE IF EXISTS expenses_stage;
```

- [ ] **Step 2: Wire it into the test migration list**

In `backend/test/helpers/db.ts`, add the import beside the others:

```ts
import gigStatusDeliveredSql from "../../migrations/0017_gig_status_delivered.sql?raw";
```

Then, after the existing `PAYMENT_ALLOCATIONS_MIGRATION` export, add the split and update `MIGRATIONS`:

```ts
// Split again at 0017, for a different reason from 0014/0015/0016:
// this migration backfills nothing, so there is no UPDATE to watch.
// What it needs a pre-state for is the DROP TABLE gigs at its heart,
// which is only meaningful against a database that has children in all
// four tables holding a foreign key into gigs.id.
export const MIGRATIONS_BEFORE_DELIVERED_STATUS = [
  ...MIGRATIONS_BEFORE_PAYMENT_ALLOCATIONS,
  PAYMENT_ALLOCATIONS_MIGRATION,
];

export const DELIVERED_STATUS_MIGRATION = gigStatusDeliveredSql;

const MIGRATIONS = [
  ...MIGRATIONS_BEFORE_DELIVERED_STATUS,
  DELIVERED_STATUS_MIGRATION,
];
```

Delete the previous `const MIGRATIONS = [...]` block — there must be exactly one.

- [ ] **Step 3: Write the migration test**

Create `backend/test/gig-status-delivered-migration.test.ts`. Read `backend/test/gig-status-cancelled-migration.test.ts` first and follow its structure; this is the same test with a fourth child table and no backfill to assert.

```ts
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
    for (const sql of MIGRATIONS_BEFORE_DELIVERED_STATUS) {
      await applyMigrationSql(env.DB, sql);
    }
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

    await applyMigrationSql(env.DB, DELIVERED_STATUS_MIGRATION);
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
```

- [ ] **Step 4: Run it**

```bash
cd backend && pnpm exec vitest run test/gig-status-delivered-migration.test.ts
```

Expected: PASS, 4 tests.

If "still rejects a status outside the enum" fails by NOT throwing, the CHECK constraint was lost in the rebuild — that is a real failure, not a flaky test.

- [ ] **Step 5: Write the re-run test**

Create `backend/test/gig-status-delivered-rerun.test.ts`, modelled on `backend/test/gig-status-cancelled-rerun.test.ts`. Read that file and mirror it: apply the first N statements of 0017 (standing in for a batch that died partway), then apply the whole file again, and assert the second pass completes and no gig or child row was lost.

Use `splitMigrationStatements(DELIVERED_STATUS_MIGRATION)` from `./helpers/db.ts` to slice the file, exactly as the 0015 re-run test does. Choose a cut point *after* `DROP TABLE IF EXISTS gigs` — that is the worst moment to fail, because the original table is gone and the staged children are still empty.

- [ ] **Step 6: Run the whole backend suite**

```bash
cd backend && pnpm test
```

Expected: PASS. Every pre-existing suite applies the full `MIGRATIONS` list, which now ends with 0017, so a mistake in the rebuild breaks everything rather than one file.

- [ ] **Step 7: Commit**

```bash
git add backend/migrations/0017_gig_status_delivered.sql backend/test/helpers/db.ts backend/test/gig-status-delivered-migration.test.ts backend/test/gig-status-delivered-rerun.test.ts
git commit -m "feat(db): widen gigs.status to allow 'delivered'"
```

---

### Task 2: The enum, in both packages

**Files:**
- Modify: `backend/src/db/schema.ts:104`
- Modify: `webapp/src/lib/types.ts:8-9`
- Test: `backend/test/gig-status-enum.test.ts`

- [ ] **Step 1: Write the failing drift test**

Create `backend/test/gig-status-enum.test.ts`:

```ts
/// <reference types="@cloudflare/vitest-pool-workers" />
/**
 * The gig lifecycle is declared twice — once for the server
 * (db/schema.ts) and once for the client (webapp/src/lib/types.ts) —
 * because the two packages share no code. Nothing makes them agree.
 *
 * They must. The server's zod validation rejects what is not in its
 * list, and the client's status filter and pill are built from its own,
 * so a value in one and not the other is either a status you can set
 * and never see, or one you can pick and never save.
 *
 * This test is worth more than either list.
 */
import { describe, it, expect } from "vitest";
import { GIG_STATUSES as SERVER_STATUSES } from "../src/db/schema.ts";
import { GIG_STATUSES as CLIENT_STATUSES } from "../../webapp/src/lib/types.ts";

describe("gig status enum", () => {
  it("is declared identically on both sides", () => {
    expect([...CLIENT_STATUSES]).toEqual([...SERVER_STATUSES]);
  });

  it("includes delivered, between completed and cancelled", () => {
    expect([...SERVER_STATUSES]).toEqual([
      "lead",
      "confirmed",
      "completed",
      "delivered",
      "cancelled",
    ]);
  });

  it("does not include paid, which is derived (migration 0015)", () => {
    expect(SERVER_STATUSES).not.toContain("paid");
  });
});
```

If importing across the package boundary fails to resolve, do NOT copy the list into the test to make it pass — that would defeat the entire point. Report it and ask; the fallback is reading `webapp/src/lib/types.ts` as raw text and parsing the array out of it.

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd backend && pnpm exec vitest run test/gig-status-enum.test.ts
```

Expected: FAIL — both lists still end at `cancelled`, so the second and third assertions fail while the first passes.

- [ ] **Step 3: Add the value on both sides**

`backend/src/db/schema.ts:104`:

```ts
export const GIG_STATUSES = ["lead", "confirmed", "completed", "delivered", "cancelled"] as const;
```

`webapp/src/lib/types.ts:8-9`:

```ts
export type GigStatus = "lead" | "confirmed" | "completed" | "delivered" | "cancelled";
export const GIG_STATUSES: GigStatus[] = ["lead", "confirmed", "completed", "delivered", "cancelled"];
```

- [ ] **Step 4: Run it and confirm it passes**

```bash
cd backend && pnpm exec vitest run test/gig-status-enum.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Satisfy `Record<GigStatus, string>`**

`STATUS_PILL_CLASSES` in `webapp/src/components/StatusPill.tsx` is typed
`Record<GigStatus, string>`, so widening `GigStatus` makes it a
typecheck error until the key exists. Add the real entry now — the
classes are final; Task 5 adds the tokens that make them resolve, and an
unresolved Tailwind class renders unstyled rather than failing to
compile:

```ts
  delivered: "bg-teal-100 text-teal-700",
```

Leave the docblock and the explanatory comment to Task 5. This step is
one line, to keep the tree compiling between commits.

- [ ] **Step 6: Typecheck both packages**

```bash
pnpm -r typecheck
```

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add backend/src/db/schema.ts webapp/src/lib/types.ts webapp/src/components/StatusPill.tsx backend/test/gig-status-enum.test.ts
git commit -m "feat(gigs): 'delivered' joins the lifecycle enum"
```

---

### Task 3: The five backend places that test for `completed`

Adding an enum value silently *subtracts* from each of these.

**Files:**
- Modify: `backend/src/services/dashboard.ts:82`, `:130`
- Modify: `backend/src/services/reports.ts:411`
- Modify: `backend/src/services/availability.ts:51`
- Modify: `backend/src/push/nudges.ts:79`
- Test: `backend/test/delivered-behaves-as-completed.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/test/delivered-behaves-as-completed.test.ts`:

```ts
/// <reference types="@cloudflare/vitest-pool-workers" />
/**
 * The rule this file pins: a delivered gig is treated exactly as a
 * completed one everywhere money or time is counted.
 *
 * Adding a value to an enum silently SUBTRACTS from every query saying
 * `status = 'completed'`. Five such places live in the backend, and
 * each fails quietly — a total that is simply smaller, with nothing to
 * indicate a row was skipped.
 *
 * Every assertion compares two users whose fixtures are identical
 * except for the status. That states the rule itself rather than
 * pinning an arithmetic result a fixture change would invalidate: widen
 * four of the five sites and the two users disagree.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations, seedUser } from "./helpers/db.ts";
import { api } from "./helpers/api.ts";
import { selectNudge } from "../src/push/nudges.ts";
import { BUSY_STATUSES } from "../src/services/availability.ts";

// Two users, identical fixtures, one status apart.
const U_DONE = "delivered-cmp-completed";
const U_SENT = "delivered-cmp-delivered";

const ACME = "aa000000-0000-4000-8000-000000000001";
const GIG = "ab000000-0000-4000-8000-000000000001";
const PAY = "ac000000-0000-4000-8000-000000000001";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

interface Dashboard {
  completedCount: number;
  unpaidCents: number;
  unpaidJobs: { gigId: string; outstandingCents: number }[];
}

async function dashboard(userId: string): Promise<Dashboard> {
  const res = await api(userId, "GET", "/api/reports/dashboard");
  expect(res.status).toBe(200);
  return (await res.json()) as Dashboard;
}

async function owedCents(userId: string): Promise<number> {
  const res = await api(userId, "GET", "/api/reports/summary");
  expect(res.status).toBe(200);
  const body = (await res.json()) as { owedCents: number };
  return body.owedCents;
}

/** The same gig and the same partial payment, under either status. */
async function seedFor(userId: string, status: string): Promise<void> {
  await seedUser(env.DB, userId);
  await api(userId, "PUT", `/api/clients/${ACME}`, { name: "Acme" });
  await api(userId, "PUT", `/api/gigs/${GIG}`, {
    clientId: ACME,
    status,
    dateTime: NOW - 30 * DAY,
    amountOfferedCents: 15000,
  });
  // Partly paid, so the gig is genuinely still owed something.
  await api(userId, "PUT", `/api/payments/${PAY}`, {
    amountCents: 5000,
    gigId: GIG,
  });
}

beforeAll(async () => {
  await applyMigrations(env.DB);
  await seedFor(U_DONE, "completed");
  await seedFor(U_SENT, "delivered");
});

describe("a delivered gig is treated as completed", () => {
  it("stays in the dashboard's outstanding total", async () => {
    const done = await dashboard(U_DONE);
    const sent = await dashboard(U_SENT);
    expect(sent.unpaidCents).toBe(done.unpaidCents);
    expect(sent.unpaidCents).toBeGreaterThan(0);
  });

  it("stays in the dashboard's unpaid job list", async () => {
    const sent = await dashboard(U_SENT);
    expect(sent.unpaidJobs.map((j) => j.gigId)).toContain(GIG);
  });

  it("is counted as completed work", async () => {
    const done = await dashboard(U_DONE);
    const sent = await dashboard(U_SENT);
    expect(sent.completedCount).toBe(done.completedCount);
    expect(sent.completedCount).toBe(1);
  });

  it("stays in the report's owed figure", async () => {
    expect(await owedCents(U_SENT)).toBe(await owedCents(U_DONE));
    expect(await owedCents(U_SENT)).toBeGreaterThan(0);
  });

  it("still raises an unpaid nudge", async () => {
    const done = await selectNudge(env.DB, U_DONE, NOW);
    const sent = await selectNudge(env.DB, U_SENT, NOW);
    expect(sent?.key).toBe(done?.key);
    expect(sent?.key).toBe(`unpaid:${GIG}`);
  });

  it("still blocks its time on the public availability page", async () => {
    // BUSY_STATUSES is what a stranger's view of a shared page is built
    // from, so assert it directly rather than inferring it from a slot
    // calculation that could pass for the wrong reason.
    expect(BUSY_STATUSES).toContain("delivered");
    expect(BUSY_STATUSES).toContain("completed");
  });
});
```

Check the two response shapes before running. `Dashboard` above is a subset of the interface in `backend/test/dashboard.test.ts`, and `owedCents` assumes `GET /api/reports/summary` returns that field. If either differs, correct the helper to match the real route rather than changing what is asserted, and say so in your report.

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd backend && pnpm exec vitest run test/delivered-behaves-as-completed.test.ts
```

Expected: FAIL — five fail because the `delivered` user's totals are zero or absent, and the sixth fails because `BUSY_STATUSES` does not yet contain the value.

- [ ] **Step 3: Widen the five sites**

`backend/src/services/availability.ts:51`:

```ts
// `delivered` is still busy: handing the work over does not free the
// time it occupied. See the delivered-status design.
export const BUSY_STATUSES: readonly GigStatus[] = ["confirmed", "completed", "delivered"];
```

`backend/src/services/dashboard.ts:82` — change `status = 'completed'` to `status IN ('completed', 'delivered')`.

`backend/src/services/dashboard.ts:130` — the same change on `g.status`.

`backend/src/services/reports.ts:411` — the same change on `g.status`.

`backend/src/push/nudges.ts:79` — this one is Drizzle, not raw SQL. Replace:

```ts
        eq(gigs.status, "completed"),
```

with:

```ts
        inArray(gigs.status, ["completed", "delivered"]),
```

and add `inArray` to the existing `drizzle-orm` import in that file.

Add a short comment at each SQL site saying why `delivered` is included, so the next person widening the enum sees the pattern:

```sql
-- 'delivered' counts here too: delivery is a milestone, not a change
-- in what the gig is owed.
```

- [ ] **Step 4: Run it and confirm it passes**

```bash
cd backend && pnpm exec vitest run test/delivered-behaves-as-completed.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Run the whole backend suite**

```bash
cd backend && pnpm test
```

Expected: PASS. Existing dashboard/reports/availability tests must be unaffected — they use `completed`, whose behaviour has not changed.

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/ backend/src/push/nudges.ts backend/test/delivered-behaves-as-completed.test.ts
git commit -m "feat(gigs): a delivered gig is still owed, still busy, still nudged"
```

---

### Task 4: The client history, where a delivered gig would vanish

**Files:**
- Modify: `webapp/src/screens/ClientEdit.tsx:206-216`
- Test: `webapp/src/screens/ClientEdit.test.tsx`

This one is a *disappearance*, not an under-count. The two groups are `completed && !isPaid` and `completed && isPaid`, so a `delivered` gig matches neither and drops out of the client's history entirely.

- [ ] **Step 1: Write the failing test**

`webapp/src/screens/ClientEdit.test.tsx` does not exist yet. Create it:

```tsx
/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientEdit } from "./ClientEdit.tsx";
import type { Client, Gig } from "../lib/types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// TanStack Query v5 schedules the store-subscription callback that
// triggers React's re-render through a real setTimeout(fn, 0).
// `await act` only drains microtasks, so without this the assertions
// race the timer and the file is non-deterministic. TanStack's own
// documented escape hatch for tests.
notifyManager.setScheduler((cb) => cb());

const CLIENT: Client = {
  id: "c1",
  name: "Acme Staffing",
  contactInfo: null,
  notes: null,
  createdAt: 0,
  modifiedAt: 0,
};

function gig(over: Partial<Gig>): Gig {
  return {
    id: "g1",
    clientId: "c1",
    title: null,
    status: "completed",
    location: null,
    dateTime: 0,
    durationMinutes: null,
    payType: "fixed",
    hourlyRateCents: null,
    workStartedAt: null,
    workEndedAt: null,
    breakMinutes: null,
    calendarEventId: null,
    amountOfferedCents: 20000,
    amountPaidCents: 0,
    expectedCents: null,
    notes: null,
    source: null,
    createdAt: 0,
    modifiedAt: 0,
    ...over,
  };
}

const api = {
  getClient: vi.fn(async () => CLIENT),
  listGigs: vi.fn(async () => [] as Gig[]),
};

vi.mock("../lib/app-context.tsx", () => ({
  useData: () => api,
  useSyncState: () => ({ online: true, pendingCount: 0 }),
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function render(gigs: Gig[]) {
  api.listGigs.mockResolvedValue(gigs);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/clients/c1"]}>
          <Routes>
            <Route path="/clients/:id" element={<ClientEdit />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return container;
}

/** The rendered text of the group whose heading is `title`. */
function groupText(el: HTMLElement, title: string): string {
  const heading = [...el.querySelectorAll("*")].find(
    (n) => n.textContent?.trim() === title,
  );
  return heading?.parentElement?.textContent ?? "";
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.clearAllMocks();
});

describe("ClientEdit history", () => {
  it("keeps an unpaid delivered gig in the not-paid group", async () => {
    const el = await render([
      gig({ id: "sent", status: "delivered", title: "Handed over", amountPaidCents: 0 }),
    ]);
    expect(groupText(el, "Completed — not paid")).toContain("Handed over");
  });

  it("keeps a paid delivered gig in the paid group", async () => {
    const el = await render([
      gig({
        id: "sent-paid",
        status: "delivered",
        title: "Handed over and settled",
        amountPaidCents: 20000,
      }),
    ]);
    expect(groupText(el, "Paid")).toContain("Handed over and settled");
  });

  it("does not lose a delivered gig from the history entirely", async () => {
    // The failure mode this file exists for. Before the fix a delivered
    // gig matched NEITHER group and vanished — harder to notice than a
    // wrong number, because nothing looks visibly off.
    const el = await render([gig({ id: "sent", status: "delivered", title: "Handed over" })]);
    expect(el.textContent).toContain("Handed over");
  });
});
```

`groupText` walks the DOM rather than assuming a testid, because `JobGroup` may not expose one. If it does, prefer the testid and simplify the helper — but do not change what is asserted.

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd webapp && pnpm exec vitest run src/screens/ClientEdit.test.tsx
```

Expected: FAIL — the delivered gig is in neither group.

- [ ] **Step 3: Widen both groups**

In `webapp/src/screens/ClientEdit.tsx`, extract the shared predicate above the two `JobGroup`s so the rule is written once:

```tsx
                  {/* 'paid' is not a status (migration 0015) — it's
                      derived (lib/gig-pay.ts). isPaid() splits on what
                      has landed against what was expected, not on
                      Boolean(amountPaidCents) — a $1 deposit on a $200
                      job is not "Paid", it's still owed.
                      'delivered' belongs in these groups too: it is
                      work that is done, and a gig that matched neither
                      would disappear from the client's history
                      entirely rather than merely being miscounted. */}
                  <JobGroup
                    title="Completed — not paid"
                    gigs={clientGigs.filter((g) => isDone(g) && !isPaid(g))}
                  />
                  <JobGroup
                    title="Paid"
                    gigs={clientGigs.filter((g) => isDone(g) && isPaid(g))}
                  />
```

with, near the top of the component file's module scope:

```tsx
/** Work that has been done, whether or not it has been handed over.
 *  Both history groups key off this rather than `status === "completed"`
 *  so a delivered gig cannot fall out of both. */
function isDone(gig: Gig): boolean {
  return gig.status === "completed" || gig.status === "delivered";
}
```

- [ ] **Step 4: Run it and confirm it passes**

```bash
cd webapp && pnpm exec vitest run src/screens/ClientEdit.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add webapp/src/screens/ClientEdit.tsx webapp/src/screens/ClientEdit.test.tsx
git commit -m "fix(clients): keep a delivered gig in the client's history"
```

---

### Task 5: Teal, the pill, and the prose that went stale

**Files:**
- Modify: `webapp/src/styles/tokens/colors.css`
- Modify: `webapp/tailwind.config.ts:44-51`
- Modify: `webapp/src/components/StatusPill.tsx`
- Modify: `webapp/src/help/scenarios/record-work.ts:85`
- Test: `webapp/src/components/StatusPill.test.tsx`

There is no free hue. `colors.css` defines tokens for `slate`, `emerald`, `sky`, `amber`, `red`, `violet` and nothing else, and `tailwind.config.ts` exposes only those scales — a class outside that set resolves to nothing. Every one is taken: slate is `lead`, sky is `confirmed`, amber is `completed`, violet is `cancelled`, emerald is the paid badge and the accent, red is the error signal. So teal is added, exactly as violet was added for `cancelled`.

- [ ] **Step 1: Write the failing test**

`webapp/src/components/StatusPill.test.tsx` already iterates `GIG_STATUSES` (line 32). Read it, then add:

```tsx
  it("gives delivered its own hue, not one another status already uses", () => {
    const classes = new Set(Object.values(STATUS_PILL_CLASSES));
    expect(classes.size).toBe(GIG_STATUSES.length);
    expect(STATUS_PILL_CLASSES.delivered).toContain("teal");
  });
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd webapp && pnpm exec vitest run src/components/StatusPill.test.tsx
```

Expected: FAIL — `STATUS_PILL_CLASSES.delivered` is undefined.

- [ ] **Step 3: Add the tokens, both theme blocks**

In `webapp/src/styles/tokens/colors.css`, add `--c-teal-100` and `--c-teal-700` alongside the existing violet pair, in **both** the light block and the dark block. Match the surrounding format exactly (space-separated RGB channels, no `rgb()` wrapper).

Use the same source ramp the other hues come from, and pick values that hold contrast on that theme's card surface in each block — light teal-100 on white, dark teal-100 on the dark card. **This codebase has shipped a control that was invisible in dark mode because `--c-slate-100` and `--c-white` resolve to the same RGB there**, so check the pair you choose against the surface in the dark block before moving on, not after.

- [ ] **Step 4: Expose the scale to Tailwind**

In `webapp/tailwind.config.ts`, beside the other scales:

```ts
        teal: scale("teal", [100, 700]),
```

- [ ] **Step 5: Explain the hue, and fix the docblock**

Task 2 already added `delivered: "bg-teal-100 text-teal-700"` to
`STATUS_PILL_CLASSES` to keep the tree compiling. Now give it the
comment the other entries have, directly above it:

```ts
  // teal, new to the palette (colors.css) for exactly this pill, the
  // way violet was added for `cancelled`. It sits between sky
  // (confirmed) and emerald (the paid badge), which is where delivered
  // sits in the lifecycle: past confirmed, heading for paid. Every
  // other hue in the palette was already spoken for.
```

and update the docblock's opening line, which currently states a lifecycle that is now wrong:

```
 * lead → confirmed → completed → delivered, with cancelled off to one
 * side rather than at the end of that line — it isn't a stage the work
 * passes through.
```

- [ ] **Step 6: Fix the help scenario's prose**

`webapp/src/help/scenarios/record-work.ts:85` tells the user in prose: *"lead → confirmed → completed, and it drives real behaviour, not just a label."* The help suite asserts targets, not sentences, so nothing fails when this goes stale.

Update that description to include `delivered`, and say what it means — that the work is handed over, and that it is still counted as owed and still blocks the time. Keep the existing explanation of what the other statuses drive; only extend it.

- [ ] **Step 6b: Fix the calendar sync header, which names one status too few**

Found during Task 2. `backend/src/calendar/sync-service.ts`'s header
states the reconciliation rules, and line 5 reads:

```
 * - `completed` keeps its event untouched (history);
```

A `delivered` gig already behaves correctly here with **no code change**:
it satisfies neither `wantsEvent` (line 132, `status === "confirmed"`)
nor `shouldDelete` (lines 156-158, lead / cancelled / confirmed-without-
date), so it falls into the same implicit catch-all as `completed` and
its event is left as history. That is exactly what this design wants.

But the header does not say so, and this repo's comments are its
documentation. Change that line to name both:

```
 * - `completed` and `delivered` keep their event untouched (history);
```

Do NOT change any logic in that file. The behaviour is already right;
only the prose is behind.

- [ ] **Step 7: Run it and confirm it passes**

```bash
cd webapp && pnpm exec vitest run src/components/StatusPill.test.tsx
```

Expected: PASS.

- [ ] **Step 8: Verify the theme, both ways**

```bash
cd webapp && pnpm exec vitest run src/lib/design-tokens.test.ts
```

Expected: PASS. If that suite asserts a fixed set of token names, extend it to cover teal rather than exempting teal from it.

- [ ] **Step 9: Commit**

```bash
git add webapp/src/styles/tokens/colors.css webapp/tailwind.config.ts webapp/src/components/StatusPill.tsx webapp/src/components/StatusPill.test.tsx webapp/src/help/scenarios/record-work.ts backend/src/calendar/sync-service.ts
git commit -m "feat(ui): a teal pill for delivered, and prose that stops being wrong"
```

---

### Task 6: The dashboard drill-down

**Files:**
- Modify: `backend/src/services/dashboard.ts`
- Modify: `webapp/src/screens/Dashboard.tsx`
- Test: `backend/test/dashboard.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `backend/test/dashboard.test.ts`, following that file's existing fixture style:

```ts
  it("counts work that is finished but not yet handed over", async () => {
    // `completed` exactly — a delivered gig has been handed over and
    // does not belong in a queue whose whole purpose is what still
    // needs delivering.
    const body = await dashboardFor(U1);
    expect(body.awaitingDeliveryCount).toBe(1);
  });
```

Seed one `completed` gig and one `delivered` gig for that user, so the assertion distinguishes the two rather than counting everything done.

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd backend && pnpm exec vitest run test/dashboard.test.ts -t "not yet handed over"
```

Expected: FAIL — `awaitingDeliveryCount` is undefined.

- [ ] **Step 3: Add the count**

In `backend/src/services/dashboard.ts`, add `awaitingDeliveryCount: number` to the response interface beside `completedCount`, and a query for it:

```ts
  // `completed` exactly, NOT the `IN ('completed','delivered')` the
  // money queries use: this is the one place where the distinction is
  // the point. Work that has been handed over is not awaiting delivery.
  const awaitingDelivery = await d1
    .prepare(
      `SELECT COUNT(*) AS n FROM gigs
       WHERE user_id = ?1 AND status = 'completed'`,
    )
    .bind(userId)
    .first<{ n: number }>();
```

and return `awaitingDeliveryCount: awaitingDelivery?.n ?? 0`.

- [ ] **Step 4: Run it and confirm it passes**

```bash
cd backend && pnpm exec vitest run test/dashboard.test.ts
```

Expected: PASS.

- [ ] **Step 5: Surface it**

In `webapp/src/screens/Dashboard.tsx`, add a `Tile` beside the existing ones, reading the new field and linking to the gig list filtered to `completed`:

```tsx
              <Tile
                label="To deliver"
                value={String(dashboard.awaitingDeliveryCount)}
                to="/gigs?status=completed"
              />
```

Match the props of the `Tile`s already there — read them rather than copying this verbatim, since the component's API is what it is and this plan may be describing it loosely. If `Tile` has no `to`, wrap it the way the neighbouring drill-down does.

Add `awaitingDeliveryCount: number` to the dashboard response interface in `webapp/src/lib/types.ts`, beside `completedCount` at line 250.

- [ ] **Step 6: Typecheck and run both suites**

```bash
pnpm -r typecheck && pnpm -r test
```

Expected: clean, all pass.

- [ ] **Step 7: Commit**

```bash
git add backend/src/services/dashboard.ts backend/test/dashboard.test.ts webapp/src/screens/Dashboard.tsx webapp/src/lib/types.ts
git commit -m "feat(dashboard): a queue for work finished but not handed over"
```

---

## Verification

- [ ] `pnpm -r typecheck` passes
- [ ] `pnpm -r test` passes
- [ ] `pnpm --filter gigsy-webapp test:e2e` passes against a LOCAL stack (`E2E_BASE_URL=http://127.0.0.1:5192 E2E_REQUIRE_AUTH=1`). Never the default — `playwright.config.ts` points at production and the specs share the prod D1.
- [ ] `pnpm --filter gigsy-webapp help:test` passes against the same local stack, with **zero flaky**
- [ ] The pre-commit hook bumped both tiers; `BASE_REF=main python scripts/check_version_bump.py` reports all tiers bumped
- [ ] `backend/migrations/0017_*.sql` applies cleanly to a local D1 that already has data: `pnpm exec wrangler d1 migrations apply gigsy-db --local`
- [ ] Manually: set a gig to `delivered`; it keeps its place in the dashboard's outstanding total and in the client's history, and its slot is still busy on the shared availability page
- [ ] Manually: the teal pill is legible in BOTH light and dark, and distinguishable from confirmed's sky and the paid badge's emerald
- [ ] Manually: a saved gig-list view created before this change still loads

## Out of scope

- No delivery metadata — no link, count or deadline. The status value only.
- No ordering enforced between `delivered` and payment.
- No `parent_gig_id`. Separate spec, separate plan, ships after this.
- No new executable help scenario. The stale prose in the existing one IS fixed.
- No change to how paid-ness is derived, and `paid` is not re-added as a status.
