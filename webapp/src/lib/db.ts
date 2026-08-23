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

/**
 * A confirmation photo waiting for a connection, keyed by the payment
 * it proves.
 *
 * It is NOT in `pendingOps`, and the reason is the shape of the write
 * rather than a preference. An outbox op is JSON posted to
 * `/api/sync`, folded with later edits and replayed idempotently; a
 * photo is megabytes of opaque bytes PUT to a different endpoint that
 * needs a payment id the server already knows about. Squeezing one
 * into the other would have meant a payload that is sometimes a record
 * and sometimes a blob, and `OutboxPayload<T> = Required<T>` — the one
 * guard standing between this app and another silently-dropped field —
 * cannot say anything useful about a Blob. A separate store keeps that
 * guard meaning exactly what it means today.
 *
 * The primary key is the payment id, so there is at most ONE photo per
 * payment: choosing a second replaces the first, the same way a second
 * edit folds into one outbox op. That matches what the server holds —
 * `confirmationKey()` in backend/src/routes/payments.ts derives one key
 * per payment — so a queue that could hold two would be promising
 * something the destination cannot keep.
 */
export interface PendingImage {
  /** Primary key — the payment whose confirmation this is. */
  paymentId: string;
  /**
   * The bytes to upload. Null ONLY once `failedReason` is set: an
   * upload the server will never accept has no use for eight megabytes
   * of quota, but the row itself survives as a tombstone so the screen
   * can say what happened instead of the photo simply disappearing.
   */
  blob: Blob | null;
  /** Sent as the object's content-type, so R2 stores it correctly. */
  contentType: string;
  /** Cached rather than read off `blob`, because it must still be
   *  readable for accounting after the blob has been dropped. */
  byteSize: number;
  /** Enqueue order for oldest-first draining. */
  queuedAt: number;
  /** Upload attempts so far — diagnostic only; nothing gives up on a
   *  count (see isPermanentUploadFailure in lib/image-queue.ts). */
  attempts: number;
  /** Non-null once the server refused it in a way retrying cannot fix.
   *  Such a row is never drained again and never counted as pending. */
  failedReason: string | null;
}

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
  pendingImages!: EntityTable<PendingImage, "paymentId">;

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
    // v4: confirmation photos waiting for a connection (phase-4 plan
    // Task 10). Additive on exactly the same terms as v3 above — a
    // version's `stores()` is a DELTA, so the six stores already there
    // are carried forward untouched and a browser holding v3 data only
    // gains an empty `pendingImages` store. No `upgrade()` runs.
    //
    // Only `queuedAt` is indexed beyond the key: the drain wants
    // oldest-first, and everything else the queue is asked (is this
    // payment's photo waiting? how many bytes are held?) is answered by
    // a scan of a table that holds a handful of rows by construction —
    // MAX_QUEUE_BYTES in lib/image-queue.ts is what keeps it that way.
    this.version(4).stores({
      pendingImages: "paymentId, queuedAt",
    });
  }
}

export function openUserDb(userId: string): GigsyUserDB {
  return new GigsyUserDB(userId);
}
