/// <reference types="@cloudflare/vitest-pool-workers" />
import initSql from "../../migrations/0000_init.sql?raw";
import refreshTokensSql from "../../migrations/0001_refresh_tokens.sql?raw";
import servicesPaymentsSql from "../../migrations/0002_services_payments.sql?raw";
import draftsSql from "../../migrations/0003_drafts.sql?raw";
import calendarSyncSql from "../../migrations/0004_calendar_sync.sql?raw";
import calendarCleanupSql from "../../migrations/0005_calendar_cleanup.sql?raw";
import durationReimbursableSql from "../../migrations/0006_duration_reimbursable.sql?raw";
import pushSubscriptionsSql from "../../migrations/0007_push_subscriptions.sql?raw";
import serverModifiedAtSql from "../../migrations/0008_server_modified_at.sql?raw";
import userSettingsSql from "../../migrations/0009_user_settings.sql?raw";
import availabilityTokensSql from "../../migrations/0010_availability_tokens.sql?raw";
import gigTitleSql from "../../migrations/0011_gig_title.sql?raw";
import activityEventsSql from "../../migrations/0012_activity_events.sql?raw";
import gigPayAndWorkLogSql from "../../migrations/0013_gig_pay_and_work_log.sql?raw";
import gigExpectedCentsSql from "../../migrations/0014_gig_expected_cents.sql?raw";
import gigStatusCancelledSql from "../../migrations/0015_gig_status_cancelled.sql?raw";
import paymentAllocationsSql from "../../migrations/0016_payment_allocations.sql?raw";
import gigStatusDeliveredSql from "../../migrations/0017_gig_status_delivered.sql?raw";

// In application order. New migrations get appended here — the test
// DB always mirrors what production migrations produce.
//
// Split at 0014 so a test can seed rows into the pre-0014 schema and
// then watch that migration's backfill act on them. Applying the whole
// list to an empty database — which is what every other suite wants —
// exercises the ALTER but never a single UPDATE, and the backfill is
// the one statement in this repo that runs once, against real money,
// with no undo.
export const MIGRATIONS_BEFORE_EXPECTED_CENTS = [
  initSql,
  refreshTokensSql,
  servicesPaymentsSql,
  draftsSql,
  calendarSyncSql,
  calendarCleanupSql,
  durationReimbursableSql,
  pushSubscriptionsSql,
  serverModifiedAtSql,
  userSettingsSql,
  availabilityTokensSql,
  gigTitleSql,
  activityEventsSql,
  gigPayAndWorkLogSql,
];

export const EXPECTED_CENTS_MIGRATION = gigExpectedCentsSql;

// Split again at 0015, for the same reason: it's the second migration
// in this repo that runs once against rows that already exist, and the
// bug it actually had (a FOREIGN KEY constraint failure the moment any
// payment, service or expense pointed at a gig) only shows up when
// there is something in those tables to violate. Every other suite
// applies migrations to an empty database, which is exactly the shape
// of test that let the bug through the first time.
export const MIGRATIONS_BEFORE_STATUS_CANCELLED = [
  ...MIGRATIONS_BEFORE_EXPECTED_CENTS,
  EXPECTED_CENTS_MIGRATION,
];

export const STATUS_CANCELLED_MIGRATION = gigStatusCancelledSql;

// Split again at 0016, for the same reason as 0014 and 0015: it
// backfills payment_allocations from every existing payments.gig_id,
// derives payments.client_id from the gig each payment pointed at, and
// rewrites gigs.amount_paid_cents from the allocations it just created
// — three UPDATE/INSERT statements that only prove anything against a
// database that already has payments, gigs and clients in it. Applied
// to an empty database (every other suite) they exercise the CREATE
// TABLE and ALTER TABLE but never a single row of backfill logic.
export const MIGRATIONS_BEFORE_PAYMENT_ALLOCATIONS = [
  ...MIGRATIONS_BEFORE_STATUS_CANCELLED,
  STATUS_CANCELLED_MIGRATION,
];

export const PAYMENT_ALLOCATIONS_MIGRATION = paymentAllocationsSql;

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

/**
 * Comment lines dropped, then split on the statement terminator — the
 * way the D1 migration runner turns one migration file into the
 * individual statements it executes. Exported on its own (not just
 * folded into applyMigrationSql) so a test can slice the list itself:
 * apply the first N statements to stand in for a batch that failed
 * partway through, then apply the whole file again to check whether it
 * self-heals.
 */
export function splitMigrationStatements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Run migration SQL the way the D1 migration runner does. Exported so a
 * test can apply a prefix of the list, seed rows, and then apply the
 * rest.
 */
export async function applyMigrationSql(
  db: D1Database,
  migrations: readonly string[],
): Promise<void> {
  for (const sql of migrations) {
    for (const stmt of splitMigrationStatements(sql)) {
      await db.prepare(stmt).run();
    }
  }
}

/**
 * Apply the real migrations to the test D1. Called from beforeAll —
 * vitest-pool-workers' isolated storage keeps beforeAll writes for the
 * whole file and rolls back per-test writes.
 */
export async function applyMigrations(db: D1Database): Promise<void> {
  await applyMigrationSql(db, MIGRATIONS);
}

/** FKs are enforced — every entity row needs its user first. */
export async function seedUser(
  db: D1Database,
  id: string,
  email = `${id}@example.com`,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO users (id, email, created_at, modified_at) VALUES (?, ?, ?, ?)",
    )
    .bind(id, email, Date.now(), Date.now())
    .run();
}
