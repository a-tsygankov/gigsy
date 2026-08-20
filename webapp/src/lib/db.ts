/**
 * Per-user offline database (docs/plan.md §7). One Dexie DB per user
 * id — hard isolation if the app is ever used on a shared device
 * (auth state lives separately in the "gigsy" DB, lib/kv.ts).
 *
 * `pendingOps` is the outbox: keyed by `entity:entityId`, so there is
 * naturally at most ONE pending op per record — later edits fold into
 * it, and the drain sends the final state (the server upsert is
 * idempotent and LWW anyway).
 */
import Dexie, { type EntityTable } from "dexie";
import type { Allocation, Client, Expense, Gig, Payment, Service } from "./types.ts";

export type SyncEntityName =
  | "client"
  | "gig"
  | "expense"
  | "service"
  | "payment"
  | "allocation";

export interface PendingOp {
  /** `${entity}:${entityId}` — primary key, one op per record. */
  opKey: string;
  entity: SyncEntityName;
  entityId: string;
  op: "upsert" | "delete";
  /** Server-input-shaped payload (absent for deletes). */
  payload?: unknown;
  /** Client edit time — the LWW signal sent to /api/sync. */
  modifiedAt: number;
  /** Enqueue order for oldest-first draining. */
  queuedAt: number;
}

export class GigsyUserDB extends Dexie {
  gigs!: EntityTable<Gig, "id">;
  clients!: EntityTable<Client, "id">;
  expenses!: EntityTable<Expense, "id">;
  services!: EntityTable<Service, "id">;
  payments!: EntityTable<Payment, "id">;
  allocations!: EntityTable<Allocation, "id">;
  pendingOps!: EntityTable<PendingOp, "opKey">;

  constructor(userId: string) {
    super(`gigsy-user-${userId}`);
    this.version(1).stores({
      gigs: "id, dateTime, modifiedAt",
      clients: "id, name, modifiedAt",
      expenses: "id, createdAt, modifiedAt",
      pendingOps: "opKey, queuedAt",
    });
    // v2: gig services + payment entries (dashboard feature).
    this.version(2).stores({
      services: "id, gigId, modifiedAt",
      payments: "id, gigId, createdAt, modifiedAt",
    });
    // v3: payment allocations — one payment can cover several gigs
    // (migration 0016). Purely additive: a version's `stores()` is a
    // DELTA over the previous one, so the five stores above are carried
    // forward untouched and a browser holding v2 data only gains an
    // empty `allocations` store. No `upgrade()` runs and nothing is
    // rewritten; the rows themselves arrive on the next pull, the same
    // way `expectedCents` did.
    this.version(3).stores({
      allocations: "id, paymentId, gigId, modifiedAt",
    });
  }
}

export function openUserDb(userId: string): GigsyUserDB {
  return new GigsyUserDB(userId);
}
