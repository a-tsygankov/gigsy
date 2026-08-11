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

// In application order. New migrations get appended here — the test
// DB always mirrors what production migrations produce.
const MIGRATIONS = [
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
];

/**
 * Apply the real migrations to the test D1. Called from beforeAll —
 * vitest-pool-workers' isolated storage keeps beforeAll writes for the
 * whole file and rolls back per-test writes.
 */
export async function applyMigrations(db: D1Database): Promise<void> {
  for (const sql of MIGRATIONS) {
    const statements = sql
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const stmt of statements) {
      await db.prepare(stmt).run();
    }
  }
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
