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
} from "./types.ts";

export type ServerRecord = Gig | Client | Expense;

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
      status: input.status ?? "lead",
      location: input.location ?? null,
      dateTime: input.dateTime ?? null,
      calendarEventId: existing?.calendarEventId ?? null,
      amountOfferedCents: input.amountOfferedCents ?? null,
      amountPaidCents: input.amountPaidCents ?? null,
      notes: input.notes ?? null,
      source: input.source ?? existing?.source ?? "manual",
      createdAt: existing?.createdAt ?? now,
      modifiedAt: now,
    };
    const payload: GigInput = {
      clientId: record.clientId,
      status: record.status,
      location: record.location,
      dateTime: record.dateTime,
      amountOfferedCents: record.amountOfferedCents,
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
    const payload: ClientInput = {
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
      createdAt: existing?.createdAt ?? now,
      modifiedAt: now,
    };
    const payload: ExpenseInput = {
      gigId: record.gigId,
      amountCents: record.amountCents,
      category: record.category,
      notes: record.notes,
    };
    await this.write("expense", id, record, payload, now);
    return record;
  }

  async removeExpense(id: string): Promise<void> {
    await this.removeEntity("expense", id);
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
