/// <reference types="@cloudflare/vitest-pool-workers" />
import initSql from "../../migrations/0000_init.sql?raw";

/**
 * Apply the real migration to the test D1. Called from beforeAll —
 * vitest-pool-workers' isolated storage keeps beforeAll writes for the
 * whole file and rolls back per-test writes.
 */
export async function applyMigrations(db: D1Database): Promise<void> {
  const statements = initSql
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
