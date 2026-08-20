/**
 * On-device source of truth (docs/plan.md §7). Every mutation writes
 * the local record AND folds into the outbox in one Dexie
 * transaction; reads never touch the network. The SyncEngine drains
 * `pendingOps` and applies server records back via
 * `applyServerRecord` (which deliberately bypasses the outbox).
 */
import type { GigsyUserDB, PendingOp, SyncEntityName } from "./db.ts";
import type {
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

export type ServerRecord = Gig | Client | Expense | Service | Payment;

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

function opKeyOf(entity: SyncEntityName, id: string): string {
  return `${entity}:${id}`;
}

export class LocalStore {
  constructor(
    private readonly db: GigsyUserDB,
    private readonly clock: () => number = Date.now,
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
    const payments = await this.db.payments.toArray();
    return payments.sort((a, b) => b.createdAt - a.createdAt);
  }

  async listPaymentsByGig(gigId: string): Promise<Payment[]> {
    const payments = await this.db.payments.where("gigId").equals(gigId).toArray();
    return payments.sort((a, b) => a.createdAt - b.createdAt);
  }

  async getPayment(id: string): Promise<Payment | null> {
    return (await this.db.payments.get(id)) ?? null;
  }

  async putPayment(id: string, input: PaymentInput): Promise<Payment> {
    const now = this.clock();
    const existing = await this.db.payments.get(id);
    const record: Payment = {
      id,
      gigId: input.gigId ?? null,
      amountCents: input.amountCents,
      paidAt: input.paidAt ?? null,
      // Server-owned; preserved locally, refreshed by pull.
      confirmationR2Key: existing?.confirmationR2Key ?? null,
      notes: input.notes ?? null,
      createdAt: existing?.createdAt ?? now,
      modifiedAt: now,
    };
    const payload: OutboxPayload<PaymentInput> = {
      gigId: record.gigId,
      amountCents: record.amountCents,
      paidAt: record.paidAt,
      notes: record.notes,
    };
    await this.write("payment", id, record, payload, now);
    return record;
  }

  async removePayment(id: string): Promise<void> {
    await this.removeEntity("payment", id);
  }

  // ── outbox + server-applied writes ──────────────────────────────
  async pendingOps(): Promise<PendingOp[]> {
    return this.db.pendingOps.orderBy("queuedAt").toArray();
  }

  async pendingCount(): Promise<number> {
    return this.db.pendingOps.count();
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
    }
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
      await table.delete(id);
      const existing = await this.db.pendingOps.get(opKeyOf(entity, id));
      await this.db.pendingOps.put({
        opKey: opKeyOf(entity, id),
        entity,
        entityId: id,
        op: "delete",
        modifiedAt: now,
        queuedAt: existing?.queuedAt ?? now,
      });
    });
  }
}
