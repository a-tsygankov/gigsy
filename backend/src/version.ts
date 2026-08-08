/**
 * Tier versions (docs/plan.md — every tier carries its own version):
 * - worker: backend/package.json, auto-bumped by the pre-commit hook,
 *   inlined into the bundle at build time via the JSON import.
 * - schema: the latest APPLIED migration, read from wrangler's own
 *   d1_migrations tracker at runtime — truthful even when the worker
 *   ships ahead of a migration (or a fresh local DB has none).
 */
import pkg from "../package.json";

export const WORKER_VERSION: string = pkg.version;

export async function getSchemaVersion(db: D1Database): Promise<string | null> {
  try {
    const row = await db
      .prepare("SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1")
      .first<{ name: string }>();
    return row?.name ?? null;
  } catch {
    // Table absent (no migrations ever applied) — not an error.
    return null;
  }
}
