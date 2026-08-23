/**
 * Outbox drain + pull-merge (docs/plan.md §7).
 *
 * Drain: pending ops go to POST /api/sync oldest-first. Per-op
 * results decide the op's fate — applied → done; skipped (stale, the
 * server copy is newer) → adopt the server copy; error → drop the
 * poison op and log (a bad op must never wedge the queue behind it).
 * A network failure leaves every op in place for the next attempt.
 *
 * Photos: a payment's confirmation image is megabytes PUT to its own
 * endpoint, so it cannot be an outbox op — it waits in `pendingImages`
 * instead and drains here, after the outbox and before the pull. Same
 * contract, different poison test: `drainImages` below, and
 * lib/image-queue.ts for what ends a photo's life in the queue.
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
import { isPermanentUploadFailure, uploadFailureReason } from "./image-queue.ts";
import type { LocalStore } from "./local-store.ts";
import type { SyncEntityName } from "./db.ts";
import { ApiError, type SyncOp, type SyncOpResult } from "./api.ts";
import type {
  Allocation,
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
  listAllocations(): Promise<Allocation[]>;
  getGig(id: string): Promise<Gig>;
  getClient(id: string): Promise<Client>;
  getExpense(id: string): Promise<Expense>;
  getService(id: string): Promise<Service>;
  getPayment(id: string): Promise<Payment>;
  getAllocation(id: string): Promise<Allocation>;
  /** Not part of `/api/sync` — a photo is bytes PUT to the payment's
   *  own confirmation endpoint. See `drainImages`. */
  uploadPaymentConfirmation(
    id: string,
    file: Blob,
  ): Promise<{ confirmationR2Key: string }>;
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
      // Photos AFTER the outbox, and only when it reached the server.
      //
      // The upload endpoint 404s on a payment D1 has never heard of,
      // and this queue's own rules call a 404 permanent — rightly, for
      // a payment somebody deleted elsewhere. A photo attached to a
      // payment created in the same offline session would hit exactly
      // that on its first attempt and be thrown away for a reason that
      // was about to stop being true. Draining the outbox first makes
      // the payment exist; requiring that drain to have SUCCEEDED is
      // what stops a failed one from producing the same false 404.
      const imagesDrained = drained ? await this.drainImages() : false;
      // Deliberately not short-circuited: a drain can fail on one poison
      // request while the pull would have hydrated the app just fine.
      ok = (await this.pull()) && drained && imagesDrained;
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
      // Asked rather than assumed zero: an empty outbox is no longer
      // the same thing as nothing pending — a queued photo counts too
      // (`pendingCount` in lib/local-store.ts), and hard-coding 0 here
      // would blank the badge while a photo was still on the device.
      this.setState({ pendingCount: await this.store.pendingCount() });
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
      const results = await this.push(wireOps);

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

  /**
   * Post the batch, then offer the ops the server REJECTED exactly one
   * more chance — after the rest of the batch has landed.
   *
   * A batch can hold two ops that are each only valid once the other
   * has applied, and no single ordering satisfies both directions. A
   * payment and its allocations are checked against each other from
   * both sides: an allocation may not exceed its payment
   * ("allocations exceed the payment"), and a payment may not shrink
   * below what is allocated to it ("amountCents is less than the
   * payment's allocated total"). Raise a payment and its split in one
   * save and the payment has to go first; lower them and the split has
   * to. A new payment and its first allocation have the same shape of
   * problem — the allocation is meaningless until the payment exists.
   *
   * Sorting the outbox cannot fix that (the direction is not knowable
   * from the queue, and folding an op preserves its original position
   * anyway), so the fix is to stop needing an order: re-offer what was
   * refused once the batch is complete. The server's upserts are
   * idempotent and last-write-wins, so a replay costs nothing but the
   * round trip, and only happens when something was actually rejected.
   *
   * An op that is genuinely invalid fails identically the second time
   * and is dropped exactly as before — the retry buys one ordering, not
   * a lower standard. Deletes are left out: they have no invariant to
   * violate, and "not found" comes back as `skipped`, not `error`.
   */
  private async push(wireOps: SyncOp[]): Promise<(SyncOpResult | undefined)[]> {
    const { results } = await this.api.sync(wireOps);
    const retryIndexes = wireOps
      .map((op, i) => (op.op === "upsert" && results[i]?.status === "error" ? i : -1))
      .filter((i) => i !== -1);
    if (retryIndexes.length === 0) return results;

    appLog.info("sync retrying rejected ops", { count: retryIndexes.length });
    const { results: retried } = await this.api.sync(
      retryIndexes.map((i) => wireOps[i]!),
    );
    const merged: (SyncOpResult | undefined)[] = [...results];
    retryIndexes.forEach((opIndex, retryIndex) => {
      const result = retried[retryIndex];
      if (result !== undefined) merged[opIndex] = result;
    });
    return merged;
  }

  // ── queued confirmation photos ───────────────────────────────────
  /**
   * Send the photos the outbox could not carry.
   *
   * A confirmation is bytes PUT to `/api/payments/:id/confirmation`,
   * not a record posted to `/api/sync`, so it cannot ride the outbox
   * (see the `PendingImage` comment in lib/db.ts). It gets the same
   * treatment nonetheless: oldest first, one pass per sync, and a
   * failure that leaves the work queued rather than losing it.
   *
   * Where it differs from `drain` is what counts as poison. An outbox
   * op is refused per-op by the server's own result, and the engine
   * drops it and adopts the server's copy. A photo has no such reply —
   * only an HTTP status — so the classification lives in
   * lib/image-queue.ts, and a photo that is refused for good becomes a
   * tombstone the payment screen can read rather than a silent
   * deletion.
   *
   * Returns false only for the transient case, which is what asks the
   * engine for another attempt. A permanent refusal is a completed
   * outcome: there is nothing left to retry, and reporting it as a
   * failed sync would put the app into a backoff it can never leave.
   */
  async drainImages(): Promise<boolean> {
    const queued = await this.store.queuedImagesToUpload();
    if (queued.length === 0) return true;
    this.setState({ syncing: true });
    let reached = true;
    try {
      for (const image of queued) {
        // The second half of the same guard the caller applies, and
        // not redundant with it: `drained` says the batch REACHED the
        // server, this says THIS payment did. A write that landed
        // while the sync was in flight, or a batch that came back
        // partly applied, leaves an op the server has not seen —
        // uploading against that id would 404, and a 404 here is
        // permanent, so the photo would be destroyed by a race rather
        // than by anything wrong with it. Skipping keeps it for the
        // next pass, by which time the payment exists.
        if (await this.store.hasPendingOp("payment", image.paymentId)) continue;
        // Belt for the tombstone: `queuedImagesToUpload` already
        // filters these out, and the compiler needs it said again.
        if (image.blob === null) continue;
        try {
          const { confirmationR2Key } = await this.api.uploadPaymentConfirmation(
            image.paymentId,
            image.blob,
          );
          await this.store.setConfirmationKey(image.paymentId, confirmationR2Key);
          await this.store.deleteQueuedImage(image.paymentId);
        } catch (e) {
          const status = e instanceof ApiError ? e.status : null;
          if (isPermanentUploadFailure(status)) {
            appLog.warn("confirmation upload refused for good", {
              paymentId: image.paymentId,
              status,
            });
            await this.store.failQueuedImage(
              image.paymentId,
              uploadFailureReason(status!),
            );
            // The next photo may be perfectly fine — one bad file must
            // not wedge the queue behind it, exactly as one poison op
            // must not wedge the outbox.
            continue;
          }
          await this.store.noteQueuedImageAttempt(image.paymentId);
          appLog.info("confirmation upload failed — still queued", {
            paymentId: image.paymentId,
            status,
            error: String(e),
          });
          // Transient means the link or the server, not this file, so
          // the ones behind it would fail the same way. Stop, and let
          // the backoff decide when to try the whole queue again.
          reached = false;
          break;
        }
      }
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
        allocation: () => this.api.getAllocation(id),
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
      // After payments: an allocation is only meaningful beside the
      // payment it splits, and this order means a single pull never
      // shows one without the other.
      await this.pullEntity("allocation", await this.api.listAllocations());
      return true;
    } catch (e) {
      appLog.info("sync pull failed", { error: String(e) });
      return false;
    }
  }

  private async pullEntity(
    entity: SyncEntityName,
    serverRows: (Gig | Client | Expense | Service | Payment | Allocation)[],
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
