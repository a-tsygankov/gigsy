/**
 * Outbox drain + pull-merge (docs/plan.md §7).
 *
 * Drain: pending ops go to POST /api/sync oldest-first. Per-op
 * results decide the op's fate — applied → done; skipped (stale, the
 * server copy is newer) → adopt the server copy; error → drop the
 * poison op and log (a bad op must never wedge the queue behind it).
 * A network failure leaves every op in place for the next attempt.
 *
 * Pull: server lists merge into the local DB. A server row wins only
 * when the record has NO pending local op; local rows absent from the
 * server (and not pending) were deleted on another device.
 *
 * Triggers: `online` event, an after-write debounce
 * (notifyLocalChange), and explicit syncNow. Scheduling and
 * online-detection are injected — unit tests never touch timers or
 * real browser events.
 */
import { appLog } from "./logger.ts";
import type { LocalStore } from "./local-store.ts";
import type { SyncEntityName } from "./db.ts";
import type { SyncOp, SyncOpResult } from "./api.ts";
import type {
  Client,
  Expense,
  Gig,
  Payment,
  ReportSummary,
  Service,
} from "./types.ts";

/** The slice of ApiClient the engine needs (DIP — tests stub this). */
export interface SyncApi {
  sync(ops: SyncOp[]): Promise<{ results: SyncOpResult[] }>;
  listGigs(): Promise<Gig[]>;
  listClients(): Promise<Client[]>;
  listExpenses(): Promise<Expense[]>;
  listServices(): Promise<Service[]>;
  listPayments(): Promise<Payment[]>;
  getGig(id: string): Promise<Gig>;
  getClient(id: string): Promise<Client>;
  getExpense(id: string): Promise<Expense>;
  getService(id: string): Promise<Service>;
  getPayment(id: string): Promise<Payment>;
}

export interface SyncState {
  online: boolean;
  syncing: boolean;
  pendingCount: number;
}

export interface SyncEngineOptions {
  /** Debounced-drain scheduler; returns a cancel fn. Default: setTimeout. */
  schedule?: (fn: () => void, ms: number) => () => void;
  debounceMs?: number;
  isOnline?: () => boolean;
  /** Event target for online/offline (default: window when present). */
  events?: Pick<EventTarget, "addEventListener" | "removeEventListener"> | null;
}

const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const handle = setTimeout(fn, ms);
  return () => clearTimeout(handle);
};

export class SyncEngine {
  private state: SyncState = { online: true, syncing: false, pendingCount: 0 };
  private listeners = new Set<() => void>();
  private cancelScheduled: (() => void) | null = null;
  private readonly schedule: (fn: () => void, ms: number) => () => void;
  private readonly debounceMs: number;
  private readonly isOnline: () => boolean;
  private readonly events: SyncEngineOptions["events"];
  private readonly onOnline = () => {
    this.setState({ online: true });
    void this.syncNow();
  };
  private readonly onOffline = () => this.setState({ online: false });

  constructor(
    private readonly store: LocalStore,
    private readonly api: SyncApi,
    options: SyncEngineOptions = {},
  ) {
    this.schedule = options.schedule ?? defaultSchedule;
    this.debounceMs = options.debounceMs ?? 800;
    this.isOnline =
      options.isOnline ??
      (() => (typeof navigator === "undefined" ? true : navigator.onLine));
    this.events =
      options.events !== undefined
        ? options.events
        : typeof window === "undefined"
          ? null
          : window;
    this.state.online = this.isOnline();
  }

  // ── observability ────────────────────────────────────────────────
  getState(): SyncState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private setState(patch: Partial<SyncState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  // ── lifecycle ────────────────────────────────────────────────────
  start(): void {
    this.events?.addEventListener("online", this.onOnline);
    this.events?.addEventListener("offline", this.onOffline);
    // Surface any outbox persisted by a previous session immediately —
    // an offline start must still show the pending badge (the drain
    // happens whenever connectivity returns).
    void this.store
      .pendingCount()
      .then((pendingCount) => this.setState({ pendingCount }));
    if (this.state.online) void this.syncNow();
  }

  stop(): void {
    this.events?.removeEventListener("online", this.onOnline);
    this.events?.removeEventListener("offline", this.onOffline);
    this.cancelScheduled?.();
  }

  /** Call after any local mutation: refreshes the pending badge now,
   * drains shortly (debounced so bursts of edits batch up). */
  async notifyLocalChange(): Promise<void> {
    this.setState({ pendingCount: await this.store.pendingCount() });
    this.cancelScheduled?.();
    this.cancelScheduled = this.schedule(() => {
      void this.syncNow();
    }, this.debounceMs);
  }

  async syncNow(): Promise<void> {
    await this.drain();
    await this.pull();
  }

  // ── drain ────────────────────────────────────────────────────────
  async drain(): Promise<void> {
    const ops = await this.store.pendingOps();
    if (ops.length === 0) {
      this.setState({ pendingCount: 0 });
      return;
    }
    this.setState({ syncing: true });
    try {
      const wireOps: SyncOp[] = ops.map((op) => ({
        entity: op.entity,
        op: op.op,
        id: op.entityId,
        modifiedAt: op.modifiedAt,
        ...(op.op === "upsert" ? { payload: op.payload } : {}),
      }));
      const { results } = await this.api.sync(wireOps);

      for (let i = 0; i < ops.length; i++) {
        const op = ops[i]!;
        const result = results[i];
        if (result === undefined) continue;
        await this.store.deleteOp(op.opKey);
        if (result.status === "skipped" && op.op === "upsert") {
          // Server copy is newer — adopt it.
          await this.refreshFromServer(op.entity, op.entityId);
        } else if (result.status === "error") {
          appLog.warn("sync op rejected", {
            entity: op.entity,
            id: op.entityId,
            reason: result.reason,
          });
        }
      }
      this.setState({ online: true });
    } catch (e) {
      // Network/auth failure: every op stays queued for the next run.
      appLog.info("sync drain failed — will retry", { error: String(e) });
      this.setState({ online: this.isOnline() });
    } finally {
      this.setState({
        syncing: false,
        pendingCount: await this.store.pendingCount(),
      });
    }
  }

  private async refreshFromServer(
    entity: SyncEntityName,
    id: string,
  ): Promise<void> {
    try {
      const getters = {
        gig: () => this.api.getGig(id),
        client: () => this.api.getClient(id),
        expense: () => this.api.getExpense(id),
        service: () => this.api.getService(id),
        payment: () => this.api.getPayment(id),
      } as const;
      await this.store.applyServerRecord(entity, await getters[entity]());
    } catch (e) {
      appLog.warn("failed to adopt server copy", { entity, id, error: String(e) });
    }
  }

  // ── pull ─────────────────────────────────────────────────────────
  async pull(): Promise<void> {
    try {
      await this.pullEntity("gig", await this.api.listGigs());
      await this.pullEntity("client", await this.api.listClients());
      await this.pullEntity("expense", await this.api.listExpenses());
      await this.pullEntity("service", await this.api.listServices());
      await this.pullEntity("payment", await this.api.listPayments());
    } catch (e) {
      appLog.info("sync pull failed — will retry", { error: String(e) });
    }
  }

  private async pullEntity(
    entity: SyncEntityName,
    serverRows: (Gig | Client | Expense | Service | Payment)[],
  ): Promise<void> {
    const serverIds = new Set(serverRows.map((r) => r.id));

    for (const row of serverRows) {
      if (await this.store.hasPendingOp(entity, row.id)) continue;
      await this.store.applyServerRecord(entity, row);
    }

    // Rows we hold that the server no longer has: deleted elsewhere —
    // unless they carry a pending op (unsynced local creation/edit).
    for (const local of await this.store.listLocal(entity)) {
      if (serverIds.has(local.id)) continue;
      if (await this.store.hasPendingOp(entity, local.id)) continue;
      await this.store.applyServerDelete(entity, local.id);
    }
  }
}

/** Reports stay server-computed (docs/plan.md §10) — re-exported here
 * so consumers of the offline layer have one import surface. */
export type { ReportSummary };
