/// <reference types="@cloudflare/vitest-pool-workers" />
/**
 * Migration 0022 against a feedback row that already existed.
 *
 * Every other suite applies the migrations to an empty database, where
 * the two ALTERs add columns to a table with nothing in it. The claim
 * the design makes — "nothing is backfilled: existing rows are
 * `general` with a null context" — is a claim about rows written
 * BEFORE the ALTER, so this file writes one against the 0021 schema
 * (by raw SQL: the repo would set `kind` on the way in, which is the
 * code path an old row never took), applies 0022, and reads it back.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import {
  applyMigrationSql,
  FEEDBACK_KIND_CONTEXT_MIGRATION,
  MIGRATIONS_BEFORE_FEEDBACK_KIND_CONTEXT,
  seedUser,
} from "./helpers/db.ts";

const U1 = "feedback-kind-migration-user";
const OLD_ID = "fb000000-0000-4000-8000-000000000001";

beforeAll(async () => {
  await applyMigrationSql(env.DB, MIGRATIONS_BEFORE_FEEDBACK_KIND_CONTEXT);
  await seedUser(env.DB, U1);
  await env.DB.prepare(
    `INSERT INTO feedback (id, user_id, user_email, message, email_status, created_at)
     VALUES (?, ?, ?, 'written before 0022', 'sent', 1)`,
  )
    .bind(OLD_ID, U1, `${U1}@example.com`)
    .run();
  await applyMigrationSql(env.DB, [FEEDBACK_KIND_CONTEXT_MIGRATION]);
});

describe("0022_feedback_kind_context", () => {
  it("an existing row reads kind = 'general' with a null context", async () => {
    const row = await env.DB.prepare(
      "SELECT kind, context_json, message FROM feedback WHERE id = ?",
    )
      .bind(OLD_ID)
      .first<{ kind: string; context_json: string | null; message: string }>();
    expect(row).toEqual({
      kind: "general",
      context_json: null,
      message: "written before 0022",
    });
  });

  it("a row inserted without naming the new columns also defaults", async () => {
    // The same DEFAULT protects a writer that predates the column —
    // say, a worker version still running mid-deploy.
    const id = "fb000000-0000-4000-8000-000000000002";
    await env.DB.prepare(
      `INSERT INTO feedback (id, user_id, user_email, message, email_status, created_at)
       VALUES (?, ?, ?, 'after, unaware', 'unsent', 2)`,
    )
      .bind(id, U1, `${U1}@example.com`)
      .run();
    const row = await env.DB.prepare("SELECT kind, context_json FROM feedback WHERE id = ?")
      .bind(id)
      .first<{ kind: string; context_json: string | null }>();
    expect(row).toEqual({ kind: "general", context_json: null });
  });
});
