/**
 * User-scoped data access for `clients`. Every method takes the
 * verified userId — the multi-tenancy boundary lives here, not in
 * the routes. Upsert-by-id supports offline idempotency: retried
 * syncs converge on one row instead of duplicating.
 */
import { and, eq } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { clients } from "../db/schema.ts";

export type ClientRecord = typeof clients.$inferSelect;

export interface ClientData {
  name: string;
  contactInfo: string | null;
  notes: string | null;
}

export interface WriteStamps {
  now: number;
  /** Offline edits carry the client's edit time (LWW); defaults to now. */
  modifiedAt?: number;
}

export type UpsertResult<T> = { record: T; created: boolean } | "forbidden";

export class ClientsRepo {
  constructor(private readonly db: DrizzleD1Database) {}

  static for(d1: D1Database): ClientsRepo {
    return new ClientsRepo(drizzle(d1));
  }

  async list(userId: string): Promise<ClientRecord[]> {
    return this.db
      .select()
      .from(clients)
      .where(eq(clients.userId, userId))
      .orderBy(clients.name);
  }

  async get(userId: string, id: string): Promise<ClientRecord | null> {
    const rows = await this.db
      .select()
      .from(clients)
      .where(and(eq(clients.id, id), eq(clients.userId, userId)));
    return rows[0] ?? null;
  }

  async upsert(
    userId: string,
    id: string,
    data: ClientData,
    stamps: WriteStamps,
  ): Promise<UpsertResult<ClientRecord>> {
    const modifiedAt = stamps.modifiedAt ?? stamps.now;
    const existingRows = await this.db
      .select()
      .from(clients)
      .where(eq(clients.id, id));
    const existing = existingRows[0];

    if (existing !== undefined && existing.userId !== userId) {
      // Someone else's row — indistinguishable from "not found" to
      // the caller (no existence leak).
      return "forbidden";
    }

    if (existing !== undefined) {
      const updated = await this.db
        .update(clients)
        .set({ ...data, modifiedAt })
        .where(and(eq(clients.id, id), eq(clients.userId, userId)))
        .returning();
      return { record: updated[0]!, created: false };
    }

    const inserted = await this.db
      .insert(clients)
      .values({ id, userId, ...data, createdAt: stamps.now, modifiedAt })
      .returning();
    return { record: inserted[0]!, created: true };
  }

  async remove(userId: string, id: string): Promise<boolean> {
    const deleted = await this.db
      .delete(clients)
      .where(and(eq(clients.id, id), eq(clients.userId, userId)))
      .returning({ id: clients.id });
    return deleted.length > 0;
  }
}
