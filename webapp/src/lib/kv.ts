/**
 * IndexedDB-backed KVStorage (Dexie) — the production implementation
 * behind AuthManager's injected storage. Phase 4 grows this database
 * with entity tables + the outbox; the auth KV rides in the same DB.
 */
import Dexie, { type EntityTable } from "dexie";
import type { KVStorage } from "./auth-store.ts";

interface KVRow {
  key: string;
  value: string;
}

class GigsyDB extends Dexie {
  kv!: EntityTable<KVRow, "key">;

  constructor() {
    super("gigsy");
    this.version(1).stores({ kv: "key" });
  }
}

export class DexieKV implements KVStorage {
  private readonly db = new GigsyDB();

  async get(key: string): Promise<string | null> {
    return (await this.db.kv.get(key))?.value ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    await this.db.kv.put({ key, value });
  }

  async del(key: string): Promise<void> {
    await this.db.kv.delete(key);
  }
}
