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
 * (notifyLocalChange), a bounded exponential backoff after a failed
 * attempt, and explicit syncNow. Scheduling and online-detection are
 * injected — unit tests never touch timers or real browser events.
 *
 * The backoff is load-bearing rather than a nicety. A failed FIRST
 * sync used to be terminal: start() ran one attempt, and the only
 * things that could schedule another were a local edit or an `online`
 * event. So a user whose first pull failed — token expired mid-flight,
 * flaky connection at app start, cold worker — sat in front of an
 * empty app, and the only ways out were both non-obvious. When the
 * retries do run out the state says so (`stalled`), because an app
 * showing nothing is indistinguishable from an account holding
 * nothing, and silence is the worst of the available answers.
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
  /** Consecutive failed sync attempts; back to 0 the moment one lands. */
  failedAttempts: number;
  /** Retries are spent. Whatever is on screen is all we have, and it
   * stays that way until the user or a reconnect asks again. */
  stalled: boolean;
}

export interface SyncEngineOptions {
  /** Debounced-drain scheduler; returns a cancel fn. Default: setTimeout. */
  schedule?: (fn: () => void, ms: number) => () => void;
  debounceMs?: number;
  isOnline?: () => boolean;
  /** Event target for online/offline (default: window when present). */
  events?: Pick<EventTarget, "addEventListener" | "removeEventListener"> | null;
  /** Delay before the first retry; each further failure doubles it. */
  retryBaseMs?: number;
  /** Retries a failed sync gets before the engine declares itself stalled. */
  maxRetries?: number;
}

const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const handle = setTimeout(fn, ms);
  return () => clearTimeout(handle);
};

// 2s doubling five times ≈ 62s of trying before giving up — long
// enough to ride out a cold worker or a token rotation, short enough
// that the user is told rather than left guessing.
const DEFAULT_RETRY_BASE_MS = 2_000;
const DEFAULT_MAX_RETRIES = 5;

export class SyncEngine {
  private state: SyncState = {
    online: true,
    syncing: false,
    pendingCount: 0,
    failedAttempts: 0,
    stalled: false,
  };
  private listeners = new Set<() => void>();
  private cancelScheduled: (() => void) | null = null;
  /** Kept apart from the debounce slot on purpose: a pending write must
   * not be pushed out to the far end of the backoff ladder, and a
   * backoff must not be cancelled by an unrelated edit. */
  private cancelRetry: (() => void) | null = null;
  private syncInFlight = false;
  private readonly schedule: (fn: () => void, ms: number) => () => void;
  private readonly debounceMs: number;
  private readonly retryBaseMs: number;
  private readonly maxRetries: number;
  private readonly isOnline: () => boolean;
  private readonly events: SyncEngineOptions["events"];
  private readonly onOnline = () => {
    this.setState({ online: true });
    // A reconnect is fresh evidence, so the ladder starts over — an
    // engine that gave up while the link was down must not stay given
    // up once it is back.
    this.resetBackoff();
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
    this.retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
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
    this.cancelScheduled = null;
    this.cancelRetry?.();
    this.cancelRetry = null;
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

  /**
   * Drain then pull, at most one at a time.
   *
   * Single-flighted because the triggers overlap by nature — the
   * backoff, the post-write debounce and the `online` event can all
   * land in the same instant, and two concurrent drains would post the
   * same ops twice.
   */
  async syncNow(): Promise<void> {
    if (this.syncInFlight) return;
    this.syncInFlight = true;
    let ok = false;
    try {
      const drained = await this.drain();
      // Deliberately not short-circuited: a drain can fail on one poison
      // request while the pull would have hydrated the app just fine.
      ok = (await this.pull()) && drained;
    } finally {
      // Released BEFORE settling, so the retry it may schedule is not
      // swallowed as a duplicate of the attempt that just ended.
      this.syncInFlight = false;
      this.settleSync(ok);
    }
  }

  /** Explicit "try again" — the stalled badge, and anything else that
   * counts as the user asking. Restarts the ladder from the first rung. */
  async retryNow(): Promise<void> {
    this.resetBackoff();
    await this.syncNow();
  }

  // ── retry ────────────────────────────────────────────────────────
  private resetBackoff(): void {
    this.cancelRetry?.();
    this.cancelRetry = null;
    if (this.state.failedAttempts !== 0 || this.state.stalled) {
      this.setState({ failedAttempts: 0, stalled: false });
    }
  }

  /** Book the outcome of one sync and decide whether another follows. */
  private settleSync(ok: boolean): void {
    if (ok) {
      this.resetBackoff();
      return;
    }
    if (!this.isOnline()) {
      // The offline badge already explains this, and `online` fires a
      // fresh sync the moment the link returns. Spending the budget
      // against a link we know is down would only exhaust it before
      // there is anything to talk to.
      return;
    }

    const attempt = this.state.failedAttempts + 1;
    if (attempt > this.maxRetries) {
      appLog.warn("sync failed — out of retries", { attempts: attempt });
      this.setState({ failedAttempts: attempt, stalled: true });
      return;
    }
    // 1×, 2×, 4×… — a server that is down stays down for a while, and
    // a phone that retries every second is a phone with a flat battery.
    const delayMs = this.retryBaseMs * 2 ** (attempt - 1);
    appLog.info("sync failed — retrying", { attempt, delayMs });
    this.setState({ failedAttempts: attempt, stalled: false });
    this.cancelRetry?.();
    this.cancelRetry = this.schedule(() => void this.syncNow(), delayMs);
  }

  // ── drain ────────────────────────────────────────────────────────
  /** True when the attempt reached the server; false leaves every op
   * queued for the next one. */
  async drain(): Promise<boolean> {
    const ops = await this.store.pendingOps();
    if (ops.length === 0) {
      this.setState({ pendingCount: 0 });
      return true;
    }
    this.setState({ syncing: true });
    let reached = true;
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
          // The op is dropped either way — a poison op must never wedge
          // the queue behind it — but for an upsert, dropping it and
          // saying nothing else leaves the device holding the write the
          // server just refused (a client-rule violation,
          // over-allocation, whatever), diverged from the server's
          // truth with no signal and no way back except a fresh edit.
          // Adopting the server's copy — the same recovery `skipped`
          // already gets above — turns "rejected silently" into
          // "reverted visibly": the local record snaps back to what the
          // server actually holds. Not done for a rejected delete: there
          // is no upload to revert, and the row this device wants gone
          // may not even exist server-side to fetch back.
          if (op.op === "upsert") {
            await this.refreshFromServer(op.entity, op.entityId);
          }
        }
      }
      this.setState({ online: true });
    } catch (e) {
      // Network/auth failure: every op stays queued for the next run,
      // which settleSync is now responsible for scheduling.
      reached = false;
      appLog.info("sync drain failed", { error: String(e) });
      this.setState({ online: this.isOnline() });
    } finally {
      this.setState({
        syncing: false,
        pendingCount: await this.store.pendingCount(),
      });
    }
    return reached;
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
  /** True when every list came back. False means the local store is
   * still whatever it was — possibly empty, on a first run. */
  async pull(): Promise<boolean> {
    try {
      await this.pullEntity("gig", await this.api.listGigs());
      await this.pullEntity("client", await this.api.listClients());
      await this.pullEntity("expense", await this.api.listExpenses());
      await this.pullEntity("service", await this.api.listServices());
      await this.pullEntity("payment", await this.api.listPayments());
      return true;
    } catch (e) {
      appLog.info("sync pull failed", { error: String(e) });
      return false;
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
