/**
 * On-device source of truth (docs/plan.md §7). Every mutation writes
 * the local record AND folds into the outbox in one Dexie
 * transaction; reads never touch the network. The SyncEngine drains
 * `pendingOps` and applies server records back via
 * `applyServerRecord` (which deliberately bypasses the outbox).
 */
import type { GigsyUserDB, PendingImage, PendingOp, SyncEntityName } from "./db.ts";
import { refuseQueuedImage, type QueueRefusal } from "./image-queue.ts";
import type {
  Allocation,
  AllocationInput,
  Client,
  ClientInput,
  Expense,
  ExpenseInput,
  Gig,
  GigInput,
  Payment,
  PaymentInput,
  Service,
  ServiceInput,
} from "./types.ts";

export type ServerRecord = Gig | Client | Expense | Service | Payment | Allocation;

/**
 * An outbox payload must name EVERY field the server accepts.
 *
 * The input types make most fields optional, which is right for
 * callers — a screen may legitimately send a partial gig. It is wrong
 * here: this object IS the wire format, and a field left out of it is
 * a field the user silently loses. The local record keeps the value
 * and the screen keeps showing it, right up until the next pull
 * overwrites it with the server's null.
 *
 * That happened. `durationMinutes` and `reimbursable` were both added
 * in Phase 9, both added to the record below, and neither added to the
 * payload — so every gig saved for months reached the server with no
 * duration, and the calendar sync rendered them all as its four-hour
 * fallback. Nothing failed; the data just never arrived.
 *
 * `Required` is what makes the next one a compile error instead.
 */
type OutboxPayload<T> = Required<T>;

/** Whether a chosen photo made it into the queue, and why not when it
 *  did not. Not an exception: the payment it belongs to has already
 *  been saved successfully by the time this is decided, and a throw
 *  here would read to the caller as the save having failed. */
export type QueueImageResult =
  | { queued: true; record: PendingImage }
  | { queued: false; refusal: QueueRefusal };

function opKeyOf(entity: SyncEntityName, id: string): string {
  return `${entity}:${id}`;
}

export class LocalStore {
  constructor(
    private readonly db: GigsyUserDB,
    private readonly clock: () => number = Date.now,
    /** Injected for the same reason `clock` is: `putPayment` has to
     *  mint an allocation id of its own, and a test that cannot predict
     *  it cannot assert on the op it queues. */
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {}

  // ── gigs ─────────────────────────────────────────────────────────
  async listGigs(): Promise<Gig[]> {
    const gigs = await this.db.gigs.toArray();
    return gigs.sort((a, b) => (b.dateTime ?? 0) - (a.dateTime ?? 0));
  }

  async getGig(id: string): Promise<Gig | null> {
    return (await this.db.gigs.get(id)) ?? null;
  }

  async putGig(id: string, input: GigInput): Promise<Gig> {
    const now = this.clock();
    const existing = await this.db.gigs.get(id);
    const record: Gig = {
      id,
      clientId: input.clientId ?? null,
      title: input.title ?? null,
      status: input.status ?? "lead",
      location: input.location ?? null,
      dateTime: input.dateTime ?? null,
      durationMinutes: input.durationMinutes ?? null,
      payType: input.payType ?? existing?.payType ?? "fixed",
      hourlyRateCents: input.hourlyRateCents ?? null,
      workStartedAt: input.workStartedAt ?? null,
      workEndedAt: input.workEndedAt ?? null,
      breakMinutes: input.breakMinutes ?? null,
      calendarEventId: existing?.calendarEventId ?? null,
      amountOfferedCents: input.amountOfferedCents ?? null,
      // Preserved from the existing row, exactly like calendarEventId
      // just above — NOT taken from `input`, even though `GigInput`
      // still nominally carries the key. Nothing supplies it any more:
      // GigEdit.tsx's "Paid ($)" input was removed when this became a
      // derived value, and lib/gig-input.ts omits the key outright (see
      // that file, and services/paid-totals.ts on the backend, for the
      // full story). This is what the server derives from payment
      // allocations; a value typed into a form is not something this
      // device is in a position to assert, and the backend ignores it
      // on arrival regardless (GigInput has no such key there either).
      // Reading it from `existing` rather than
      // hard-coding null (the expectedCents treatment below) is
      // deliberate: unlike expectedCents, there is no local derivation
      // to fall back on while waiting for the next pull, so the last
      // value the server actually reported is the best available
      // answer to "how much has been paid" in the meantime.
      amountPaidCents: existing?.amountPaidCents ?? null,
      // The ONE field that must NOT reach the payload below, against
      // everything the OutboxPayload comment says. It is not a field
      // the server accepts: `expectedCents` is derived and server-owned
      // (migration 0014), absent from GigInput, and GigsRepo.upsert
      // recomputes it on every write. Sending one would be ignored at
      // best; the reason it is worth being deliberate about is that the
      // outbox is the one thing an offline client can push, so the
      // discipline that keeps fields IN the payload is exactly the
      // discipline that has to keep this one out. `Required<GigInput>`
      // enforces that for free — GigInput has no such key.
      //
      // Null rather than the local derivation, and deliberately not
      // carried over from `existing`: this field means "what the server
      // said", and an edit has just invalidated whatever it last said.
      // The screens derive locally on read instead
      // (storedOrDerivedExpectedCents in lib/gig-pay.ts), so a stale
      // number can never be shown or stored.
      expectedCents: null,
      notes: input.notes ?? null,
      source: input.source ?? existing?.source ?? "manual",
      createdAt: existing?.createdAt ?? now,
      modifiedAt: now,
    };
    const payload: OutboxPayload<GigInput> = {
      clientId: record.clientId,
      title: record.title,
      status: record.status,
      location: record.location,
      dateTime: record.dateTime,
      durationMinutes: record.durationMinutes,
      payType: record.payType,
      hourlyRateCents: record.hourlyRateCents,
      workStartedAt: record.workStartedAt,
      workEndedAt: record.workEndedAt,
      breakMinutes: record.breakMinutes,
      amountOfferedCents: record.amountOfferedCents,
      // Required because `GigInput` still nominally carries the key
      // (see the comment on `record.amountPaidCents` above) — but the
      // backend's own GigInput has no such key, so this is dead weight
      // on the wire rather than a write: whatever value ends up here,
      // the server derives its own and discards this one.
      amountPaidCents: record.amountPaidCents,
      notes: record.notes,
      source: (record.source ?? "manual") as "manual" | "email" | "photo",
    };
    await this.write("gig", id, record, payload, now);
    return record;
  }

  async removeGig(id: string): Promise<void> {
    await this.removeEntity("gig", id);
  }

  // ── clients ──────────────────────────────────────────────────────
  async listClients(): Promise<Client[]> {
    const clients = await this.db.clients.toArray();
    return clients.sort((a, b) => a.name.localeCompare(b.name));
  }

  async getClient(id: string): Promise<Client | null> {
    return (await this.db.clients.get(id)) ?? null;
  }

  async putClient(id: string, input: ClientInput): Promise<Client> {
    const now = this.clock();
    const existing = await this.db.clients.get(id);
    const record: Client = {
      id,
      name: input.name,
      contactInfo: input.contactInfo ?? null,
      notes: input.notes ?? null,
      createdAt: existing?.createdAt ?? now,
      modifiedAt: now,
    };
    const payload: OutboxPayload<ClientInput> = {
      name: record.name,
      contactInfo: record.contactInfo,
      notes: record.notes,
    };
    await this.write("client", id, record, payload, now);
    return record;
  }

  async removeClient(id: string): Promise<void> {
    await this.removeEntity("client", id);
  }

  // ── expenses ─────────────────────────────────────────────────────
  async listExpenses(): Promise<Expense[]> {
    const expenses = await this.db.expenses.toArray();
    return expenses.sort((a, b) => b.createdAt - a.createdAt);
  }

  async getExpense(id: string): Promise<Expense | null> {
    return (await this.db.expenses.get(id)) ?? null;
  }

  async putExpense(id: string, input: ExpenseInput): Promise<Expense> {
    const now = this.clock();
    const existing = await this.db.expenses.get(id);
    const record: Expense = {
      id,
      gigId: input.gigId ?? null,
      amountCents: input.amountCents,
      category: input.category ?? null,
      receiptR2Key: existing?.receiptR2Key ?? null,
      notes: input.notes ?? null,
      reimbursable: input.reimbursable ?? false,
      createdAt: existing?.createdAt ?? now,
      modifiedAt: now,
    };
    const payload: OutboxPayload<ExpenseInput> = {
      gigId: record.gigId,
      amountCents: record.amountCents,
      category: record.category,
      notes: record.notes,
      reimbursable: record.reimbursable,
    };
    await this.write("expense", id, record, payload, now);
    return record;
  }

  async removeExpense(id: string): Promise<void> {
    await this.removeEntity("expense", id);
  }

  // ── services ─────────────────────────────────────────────────────
  async listServices(): Promise<Service[]> {
    const services = await this.db.services.toArray();
    return services.sort((a, b) => b.createdAt - a.createdAt);
  }

  async listServicesByGig(gigId: string): Promise<Service[]> {
    const services = await this.db.services.where("gigId").equals(gigId).toArray();
    return services.sort((a, b) => a.createdAt - b.createdAt);
  }

  async getService(id: string): Promise<Service | null> {
    return (await this.db.services.get(id)) ?? null;
  }

  async putService(id: string, input: ServiceInput): Promise<Service> {
    const now = this.clock();
    const existing = await this.db.services.get(id);
    const record: Service = {
      id,
      gigId: input.gigId,
      description: input.description,
      amountOfferedCents: input.amountOfferedCents ?? null,
      amountPaidCents: input.amountPaidCents ?? null,
      paymentId: input.paymentId ?? null,
      isCompleted: input.isCompleted ?? false,
      createdAt: existing?.createdAt ?? now,
      modifiedAt: now,
    };
    const payload: OutboxPayload<ServiceInput> = {
      gigId: record.gigId,
      description: record.description,
      amountOfferedCents: record.amountOfferedCents,
      amountPaidCents: record.amountPaidCents,
      paymentId: record.paymentId,
      isCompleted: record.isCompleted,
    };
    await this.write("service", id, record, payload, now);
    return record;
  }

  async removeService(id: string): Promise<void> {
    await this.removeEntity("service", id);
  }

  // ── payments ─────────────────────────────────────────────────────
  async listPayments(): Promise<Payment[]> {
    const payments = await this.resolveGigs(await this.db.payments.toArray());
    return payments.sort((a, b) => b.createdAt - a.createdAt);
  }

  async listPaymentsByGig(gigId: string): Promise<Payment[]> {
    // Two sources, because both are true during the migration: the
    // allocations this build writes, and the legacy `gigId` column the
    // server still holds for payments no allocations-aware client has
    // re-saved yet. A payment reachable either way belongs in the list.
    const allocated = await this.db.allocations.where("gigId").equals(gigId).toArray();
    const byColumn = await this.db.payments.where("gigId").equals(gigId).toArray();
    const ids = new Set([
      ...allocated.map((a) => a.paymentId),
      ...byColumn.map((p) => p.id),
    ]);
    const rows = await this.db.payments.bulkGet([...ids]);
    const payments = await this.resolveGigs(
      rows.filter((row): row is Payment => row !== undefined),
    );
    return payments.sort((a, b) => a.createdAt - b.createdAt);
  }

  async getPayment(id: string): Promise<Payment | null> {
    const payment = await this.db.payments.get(id);
    if (payment === undefined) return null;
    return this.withResolvedGig(
      payment,
      await this.db.allocations.where("paymentId").equals(id).toArray(),
    );
  }

  /**
   * Writes the payment, and — only when the caller supplies a `gigId` —
   * the single allocation that `gigId` stands for.
   *
   * THE PAYLOAD DOES NOT CARRY `gigId`, and that is the whole point.
   *
   * Server-side, a payment write carrying a non-null `gigId` runs
   * `AllocationsRepo.replaceSoleAllocation`: the payment's allocations
   * are deleted and replaced by ONE for the payment's full amount. That
   * is right for a client that predates allocations, and catastrophic
   * for one that manages them. A user who records a 150.00 payment,
   * allocates 50.00 to a gig and deliberately leaves 100.00 unallocated
   * has a payment with exactly one allocation — which the server's
   * split guard (>1) does not protect — so the next save would inflate
   * that allocation to 150.00 and the remainder would vanish. That
   * partially-allocated state is the normal one, not an edge case.
   *
   * So this build stops sending the field and does the translation
   * itself, against the local allocations it already holds. The server
   * keeps its compat path for the builds still in the field:
   *
   *  - A payment created by an OLD client arrives here with a `gigId`
   *    and one server-made allocation, which the pull hands us. We
   *    update THAT row (by its own id) rather than minting a second, so
   *    the server sees an ordinary update and the two never double up.
   *  - An outbox op queued by an old build keeps its old payload —
   *    `gigId` and all — and drains through the server's compat path
   *    untouched. Nothing here rewrites a queued op; a later edit on
   *    this build simply replaces it wholesale.
   *
   * The amount written to the sole allocation is the payment's full
   * amount, matching `replaceSoleAllocation` exactly: a caller that
   * says "this payment was for that gig" and nothing else is saying the
   * whole of it was. Callers that mean something finer (Task 7's split
   * editor) pass no `gigId` at all and write allocations directly, and
   * this branch never runs for them.
   */
  async putPayment(id: string, input: PaymentInput): Promise<Payment> {
    const now = this.clock();
    const existing = await this.db.payments.get(id);
    const record: Payment = {
      id,
      // Kept in step with what the server will hold after this write:
      // it takes `gigId` as absent-means-null too. Nothing reads it
      // directly any more — `resolveGigs` below answers "which gig" from
      // the allocations, falling back to this column only for payments
      // no allocations-aware client has touched yet.
      gigId: input.gigId ?? null,
      // Preserve-on-absent, matching `PaymentsRepo.upsert` exactly
      // (backend/src/repos/payments.ts). NOT `?? null` like the fields
      // around it: this one goes out on the wire below, so an absent
      // key here would be sent as an explicit null and CLEAR the
      // client — the very thing the server's preserve-on-absent rule
      // exists to stop an older build doing. A caller that means
      // "no client" says so with `null`.
      clientId:
        input.clientId === undefined ? (existing?.clientId ?? null) : input.clientId,
      amountCents: input.amountCents,
      paidAt: input.paidAt ?? null,
      // Server-owned; preserved locally, refreshed by pull.
      confirmationR2Key: existing?.confirmationR2Key ?? null,
      notes: input.notes ?? null,
      createdAt: existing?.createdAt ?? now,
      modifiedAt: now,
    };
    // `Omit`, not a hand-written object type: the `Required<T>` guard
    // still has to bite if PaymentInput grows a field (that is what it
    // is for), while `gigId` is excluded deliberately and in one place.
    const payload: OutboxPayload<Omit<PaymentInput, "gigId">> = {
      // The preserved-or-given value, never `input.clientId` — see the
      // record field above. Sending the record's copy is what makes
      // "absent means leave it alone" true across the wire as well as
      // in Dexie.
      clientId: record.clientId,
      amountCents: record.amountCents,
      paidAt: record.paidAt,
      notes: record.notes,
    };
    // One transaction over both tables: a payment that reached the disk
    // without its allocation would show as unallocated money the user
    // never left unallocated. `write` opens a sub-transaction whose
    // scope is a subset of this one, so Dexie joins them rather than
    // nesting a second.
    await this.db.transaction(
      "rw",
      this.db.payments,
      this.db.allocations,
      this.db.pendingOps,
      async () => {
        await this.write("payment", id, record, payload, now);
        if (input.gigId != null) {
          await this.writeSoleAllocation(id, input.gigId, record.amountCents, now);
        }
      },
    );
    return record;
  }

  async removePayment(id: string): Promise<void> {
    const now = this.clock();
    await this.db.transaction(
      "rw",
      this.db.payments,
      this.db.allocations,
      this.db.pendingOps,
      this.db.pendingImages,
      async () => {
        // A photo waiting for a payment that is being deleted has
        // nowhere to land: the upload endpoint 404s on a payment the
        // server does not have, which the drain would (correctly) call
        // a permanent failure and leave as a tombstone complaining
        // about a record nobody can look at any more. Dropping it here
        // costs the same bytes and says nothing false.
        await this.db.pendingImages.delete(id);
        // Local-only, no outbox ops: deleting a payment server-side
        // already deletes its allocations (routes/payments.ts and the
        // sync delete path both do it — `payment_allocations.payment_id`
        // has no ON DELETE CASCADE, so they must). Queueing allocation
        // deletes on top would be redundant work that can only race
        // with it. Dropping them locally keeps the gig screens honest
        // in the meantime.
        const orphaned = await this.db.allocations
          .where("paymentId")
          .equals(id)
          .primaryKeys();
        await this.db.allocations.bulkDelete(orphaned);
        await this.enqueueRemoval("payment", id, now);
      },
    );
  }

  // ── allocations ──────────────────────────────────────────────────
  async listAllocationsByPayment(paymentId: string): Promise<Allocation[]> {
    const allocations = await this.db.allocations
      .where("paymentId")
      .equals(paymentId)
      .toArray();
    return allocations.sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * Every allocation, for callers that need many payments' states at
   * once. `listAllocationsByPayment` takes one id, and a list screen
   * calling it per row is a query per row.
   */
  async listAllocations(): Promise<Allocation[]> {
    return this.db.allocations.toArray();
  }

  async listAllocationsByGig(gigId: string): Promise<Allocation[]> {
    const allocations = await this.db.allocations.where("gigId").equals(gigId).toArray();
    return allocations.sort((a, b) => a.createdAt - b.createdAt);
  }

  async getAllocation(id: string): Promise<Allocation | null> {
    return (await this.db.allocations.get(id)) ?? null;
  }

  async putAllocation(id: string, input: AllocationInput): Promise<Allocation> {
    return this.writeAllocation(id, input, this.clock());
  }

  async removeAllocation(id: string): Promise<void> {
    await this.removeEntity("allocation", id);
  }

  // ── queued confirmation photos ───────────────────────────────────
  /**
   * Hold a payment's confirmation photo until there is a connection to
   * send it on.
   *
   * Unconditional — this is NOT an "if offline" path. The alternative
   * was to upload directly when `navigator.onLine` says yes and queue
   * otherwise, which means two code paths, one of them exercised only
   * by the rarer half of the users, and a lie in the middle of it:
   * `onLine` reports a link, not a reachable server. Queueing always
   * gives every photo the same journey, and the sync engine's drain
   * runs immediately when there is a connection, so the online case
   * costs the debounce and nothing else.
   *
   * Replaces whatever was queued for this payment, including a
   * previously failed one — choosing a new photo is the user's answer
   * to "that one could not be sent".
   */
  async queueImage(paymentId: string, blob: Blob): Promise<QueueImageResult> {
    const now = this.clock();
    return this.db.transaction("rw", this.db.pendingImages, async () => {
      // The bytes this payment already holds do not count against the
      // ceiling: they are about to be replaced, and charging for both
      // copies would refuse a swap that frees space.
      const queuedBytes = (await this.db.pendingImages.toArray())
        .filter((image) => image.paymentId !== paymentId)
        .reduce((total, image) => total + image.byteSize, 0);
      const refusal = refuseQueuedImage(blob.size, queuedBytes);
      if (refusal !== null) return { queued: false, refusal };
      const record: PendingImage = {
        paymentId,
        blob,
        contentType: blob.type === "" ? "application/octet-stream" : blob.type,
        byteSize: blob.size,
        queuedAt: now,
        attempts: 0,
        failedReason: null,
      };
      await this.db.pendingImages.put(record);
      return { queued: true, record };
    });
  }

  /** This payment's queued photo — including a failed tombstone, which
   *  is the whole reason the screen asks. */
  async queuedImage(paymentId: string): Promise<PendingImage | null> {
    return (await this.db.pendingImages.get(paymentId)) ?? null;
  }

  /** What the drain should try, oldest first. Failed tombstones are
   *  excluded here rather than skipped by the caller, so there is one
   *  place that decides what "still waiting" means. */
  async queuedImagesToUpload(): Promise<PendingImage[]> {
    const images = await this.db.pendingImages.orderBy("queuedAt").toArray();
    return images.filter((image) => image.failedReason === null && image.blob !== null);
  }

  async deleteQueuedImage(paymentId: string): Promise<void> {
    await this.db.pendingImages.delete(paymentId);
  }

  /** Give up on this photo, keep the fact that it existed. The blob
   *  goes because it will never be accepted and quota is finite; the
   *  row stays because a payment that quietly stops mentioning the
   *  photo you attached is the failure this whole task exists to
   *  avoid. */
  async failQueuedImage(paymentId: string, reason: string): Promise<void> {
    await this.db.pendingImages
      .where("paymentId")
      .equals(paymentId)
      .modify((image) => {
        image.blob = null;
        image.failedReason = reason;
        image.attempts += 1;
      });
  }

  async noteQueuedImageAttempt(paymentId: string): Promise<void> {
    await this.db.pendingImages
      .where("paymentId")
      .equals(paymentId)
      .modify((image) => {
        image.attempts += 1;
      });
  }

  /** Photos still waiting — a tombstone is not waiting for anything. */
  async queuedImageCount(): Promise<number> {
    return (await this.queuedImagesToUpload()).length;
  }

  /**
   * Record the R2 key a completed upload returned, locally and only
   * locally.
   *
   * No outbox op, on the same grounds as `applyServerRecord`: the key
   * is server-owned (`confirmationKey()` derives it, and the PUT route
   * has already written it to D1), so this is adopting a fact rather
   * than asserting one. Sending it back would be an older build's
   * mistake — see `expectedCents` in `putGig` for the same rule.
   *
   * Done here rather than left to the pull that follows in the same
   * sync, because a pull that fails would otherwise leave a payment
   * whose photo is on the server, gone from the queue, and invisible on
   * the device until the next successful cycle.
   */
  async setConfirmationKey(paymentId: string, key: string): Promise<void> {
    await this.db.payments
      .where("id")
      .equals(paymentId)
      .modify((payment) => {
        payment.confirmationR2Key = key;
      });
  }

  // ── outbox + server-applied writes ──────────────────────────────
  async pendingOps(): Promise<PendingOp[]> {
    return this.db.pendingOps.orderBy("queuedAt").toArray();
  }

  /**
   * Everything this device is holding that the server has not seen —
   * outbox ops AND queued photos.
   *
   * The photos are counted deliberately. This number is what SyncBadge
   * renders, and the badge's claim is "N changes waiting to sync"; a
   * payment saved with a photo that has reached neither the server nor
   * the count would show as fully synced while its proof sat on the
   * device. Counting it is what makes the badge's silence trustworthy.
   */
  async pendingCount(): Promise<number> {
    return (await this.db.pendingOps.count()) + (await this.queuedImageCount());
  }

  async deleteOp(opKey: string): Promise<void> {
    await this.db.pendingOps.delete(opKey);
  }

  async hasPendingOp(entity: SyncEntityName, id: string): Promise<boolean> {
    return (await this.db.pendingOps.get(opKeyOf(entity, id))) !== undefined;
  }

  /** Every record of this entity with unsent changes. The outbox holds
   *  at most one op per record and is drained continuously, so it is
   *  small enough to scan rather than index. */
  async pendingIds(entity: SyncEntityName): Promise<Set<string>> {
    const ops = await this.db.pendingOps.toArray();
    return new Set(
      ops.filter((op) => op.entity === entity).map((op) => op.entityId),
    );
  }

  /** Write a server-authoritative record locally, bypassing the
   * outbox (pull-merge and stale-skip refresh both land here). */
  async applyServerRecord(
    entity: SyncEntityName,
    record: ServerRecord,
  ): Promise<void> {
    await this.tableOf(entity).put(record as never);
  }

  /** Remove a record locally without enqueueing (server-side delete
   * observed during pull). */
  async applyServerDelete(entity: SyncEntityName, id: string): Promise<void> {
    await this.tableOf(entity).delete(id);
  }

  async listLocal(entity: SyncEntityName): Promise<ServerRecord[]> {
    return this.tableOf(entity).toArray();
  }

  // ── internals ────────────────────────────────────────────────────
  private tableOf(entity: SyncEntityName) {
    switch (entity) {
      case "gig":
        return this.db.gigs;
      case "client":
        return this.db.clients;
      case "expense":
        return this.db.expenses;
      case "service":
        return this.db.services;
      case "payment":
        return this.db.payments;
      case "allocation":
        return this.db.allocations;
    }
  }

  private async writeAllocation(
    id: string,
    input: AllocationInput,
    now: number,
  ): Promise<Allocation> {
    const existing = await this.db.allocations.get(id);
    const record: Allocation = {
      id,
      paymentId: input.paymentId,
      gigId: input.gigId,
      amountCents: input.amountCents,
      createdAt: existing?.createdAt ?? now,
      modifiedAt: now,
    };
    const payload: OutboxPayload<AllocationInput> = {
      paymentId: record.paymentId,
      gigId: record.gigId,
      amountCents: record.amountCents,
    };
    await this.write("allocation", id, record, payload, now);
    return record;
  }

  /**
   * The client-side twin of `AllocationsRepo.replaceSoleAllocation`,
   * with its guard: a payment already carrying a SPLIT is left alone,
   * because a `gigId` — from a legacy caller or from the one-gig
   * payment screen — cannot have authored the split it would be
   * overwriting, and reading it as authoritative is how money silently
   * moves between gigs.
   *
   * Where it deliberately differs: the existing row is UPDATED under
   * its own id instead of being deleted and re-inserted under a fresh
   * one. The server can churn the id because it owns both sides of the
   * write; here the id is the outbox key and the sync identity, so
   * keeping it is what makes a repeated save fold into one op and
   * converge under last-write-wins — including on an allocation the
   * SERVER minted for a payment an older build created.
   */
  private async writeSoleAllocation(
    paymentId: string,
    gigId: string,
    amountCents: number,
    now: number,
  ): Promise<void> {
    const existing = await this.db.allocations
      .where("paymentId")
      .equals(paymentId)
      .toArray();
    if (existing.length > 1) return;
    await this.writeAllocation(
      existing[0]?.id ?? this.newId(),
      { paymentId, gigId, amountCents },
      now,
    );
  }

  /**
   * `Payment.gigId` as the screens should read it: from the payment's
   * allocations, falling back to the stored legacy column.
   *
   * The column is no longer sent (see `putPayment`), so the server
   * nulls it on the next save of any payment — while the allocation
   * that replaced it says the same thing and more. Resolving on read
   * keeps "which gig was this for" answerable from one place during the
   * migration, whichever half of it a given payment is in.
   *
   * A payment split across several gigs resolves to `null`: there is no
   * single gig, and any answer that named one would be a lie a caller
   * could act on. Callers that can show a split read the allocations.
   */
  private withResolvedGig(payment: Payment, allocations: Allocation[]): Payment {
    if (allocations.length === 0) return payment;
    return {
      ...payment,
      gigId: allocations.length === 1 ? allocations[0]!.gigId : null,
    };
  }

  /** Bulk `withResolvedGig`. Scans the allocations table once rather
   *  than querying per payment — the same "small enough to scan"
   *  argument `pendingIds` makes, for data of the same order. */
  private async resolveGigs(payments: Payment[]): Promise<Payment[]> {
    if (payments.length === 0) return payments;
    const byPayment = new Map<string, Allocation[]>();
    for (const allocation of await this.db.allocations.toArray()) {
      const group = byPayment.get(allocation.paymentId);
      if (group === undefined) byPayment.set(allocation.paymentId, [allocation]);
      else group.push(allocation);
    }
    return payments.map((payment) =>
      this.withResolvedGig(payment, byPayment.get(payment.id) ?? []),
    );
  }

  private async write(
    entity: SyncEntityName,
    id: string,
    record: ServerRecord,
    payload: unknown,
    now: number,
  ): Promise<void> {
    const table = this.tableOf(entity);
    await this.db.transaction("rw", table, this.db.pendingOps, async () => {
      await table.put(record as never);
      const existing = await this.db.pendingOps.get(opKeyOf(entity, id));
      await this.db.pendingOps.put({
        opKey: opKeyOf(entity, id),
        entity,
        entityId: id,
        op: "upsert",
        payload,
        modifiedAt: now,
        queuedAt: existing?.queuedAt ?? now,
      });
    });
  }

  private async removeEntity(entity: SyncEntityName, id: string): Promise<void> {
    const now = this.clock();
    const table = this.tableOf(entity);
    await this.db.transaction("rw", table, this.db.pendingOps, async () => {
      await this.enqueueRemoval(entity, id, now);
    });
  }

  /** The delete half of `removeEntity`, without the transaction —
   *  callers that already hold one (`removePayment`, which has the
   *  allocations table in scope too) reuse it rather than nesting. */
  private async enqueueRemoval(
    entity: SyncEntityName,
    id: string,
    now: number,
  ): Promise<void> {
    await this.tableOf(entity).delete(id);
    const existing = await this.db.pendingOps.get(opKeyOf(entity, id));
    await this.db.pendingOps.put({
      opKey: opKeyOf(entity, id),
      entity,
      entityId: id,
      op: "delete",
      modifiedAt: now,
      queuedAt: existing?.queuedAt ?? now,
    });
  }
}
