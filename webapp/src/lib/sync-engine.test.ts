import "fake-indexeddb/auto";
import { describe, it, expect, vi } from "vitest";
import { openUserDb } from "./db.ts";
import { LocalStore } from "./local-store.ts";
import {
  SyncEngine,
  type SyncApi,
  type SyncEngineOptions,
} from "./sync-engine.ts";
import { ApiError, type SyncOp, type SyncOpResult } from "./api.ts";
import type { Allocation, Gig, Payment } from "./types.ts";

let seq = 0;
const G1 = "11111111-1111-4111-8111-111111111111";
const C1 = "22222222-2222-4222-8222-222222222222";

function serverGig(overrides: Partial<Gig> = {}): Gig {
  return {
    id: G1,
    clientId: null,
    title: null,
    status: "completed",
    location: "server copy",
    dateTime: null,
    durationMinutes: null,
    payType: "fixed",
    hourlyRateCents: null,
    workStartedAt: null,
    workEndedAt: null,
    breakMinutes: null,
    calendarEventId: null,
    amountOfferedCents: null,
    amountPaidCents: null,
    expectedCents: null,
    notes: null,
    source: "manual",
    createdAt: 1,
    modifiedAt: 9999,
    ...overrides,
  };
}

function stubApi(overrides: Partial<SyncApi> = {}): SyncApi {
  const unexpected = vi.fn(async () => {
    throw new Error("unexpected");
  });
  return {
    sync: vi.fn(async (ops: SyncOp[]) => ({
      results: ops.map((o) => ({ id: o.id, status: "applied" as const })),
    })),
    listGigs: vi.fn(async () => []),
    listClients: vi.fn(async () => []),
    listExpenses: vi.fn(async () => []),
    listServices: vi.fn(async () => []),
    listPayments: vi.fn(async () => []),
    listAllocations: vi.fn(async () => []),
    getGig: vi.fn(async () => serverGig()),
    getClient: unexpected as never,
    getExpense: unexpected as never,
    getService: unexpected as never,
    getPayment: unexpected as never,
    getAllocation: unexpected as never,
    // Deliberately explosive by default. A photo upload is the one
    // thing in this engine that moves megabytes, and a test that
    // triggers one without meaning to should say so loudly rather than
    // quietly succeed against a permissive stub.
    uploadPaymentConfirmation: unexpected as never,
    ...overrides,
  };
}

function makeEngine(
  api: SyncApi,
  clockValue = () => 1000,
  options: SyncEngineOptions = {},
) {
  const db = openUserDb(`sync-${++seq}`);
  const store = new LocalStore(db, clockValue);
  // Every delay the engine asked for, in order — the only way to assert
  // on backoff without letting real time into a unit test.
  const delays: number[] = [];
  const engine = new SyncEngine(store, api, {
    // Immediate scheduler — no timers in unit tests.
    schedule: (fn, ms) => {
      delays.push(ms);
      void fn();
      return () => undefined;
    },
    isOnline: () => true,
    events: null,
    ...options,
  });
  return { store, db, engine, api, delays };
}

/** An outbox entry as the pre-allocations build wrote it: the payment
 *  payload still carries `gigId`. Written straight to the table because
 *  no code path in this build produces one any more. */
async function queueLegacyPaymentOp(
  db: ReturnType<typeof openUserDb>,
  paymentId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await db.pendingOps.put({
    opKey: `payment:${paymentId}`,
    entity: "payment",
    entityId: paymentId,
    op: "upsert",
    payload,
    modifiedAt: 500,
    queuedAt: 500,
  });
}

const rejects = (status = 401) =>
  vi.fn(async () => {
    throw new ApiError(status, "session expired");
  });

describe("SyncEngine.drain", () => {
  it("sends pending ops oldest-first and clears applied ones", async () => {
    let now = 1000;
    const api = stubApi();
    const { store, engine } = makeEngine(api, () => now++);
    await store.putClient(C1, { name: "Acme" });
    await store.putGig(G1, { status: "lead" });

    await engine.drain();

    const sent = (api.sync as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      entity: string;
    }[];
    expect(sent.map((o) => o.entity)).toEqual(["client", "gig"]);
    expect(await store.pendingCount()).toBe(0);
  });

  it("on skipped(stale): drops the op and adopts the server copy", async () => {
    const api = stubApi({
      sync: vi.fn(async () => ({
        results: [{ id: G1, status: "skipped" as const, reason: "stale" }],
      })),
    });
    const { store, engine } = makeEngine(api);
    await store.putGig(G1, { status: "lead", location: "local edit" });

    await engine.drain();

    expect(await store.pendingCount()).toBe(0);
    const gig = await store.getGig(G1);
    expect(gig?.location).toBe("server copy");
  });

  it("on error result for an upsert: drops the poison op and adopts the server copy", async () => {
    // I3 (code review, 2026-08-19): a rejected write used to be dropped
    // silently, leaving the device holding the edit the server just
    // refused — diverged from the server's truth with no signal and no
    // way back short of a fresh edit. This is the same recovery
    // `skipped` already gets: adopt what the server actually holds.
    const api = stubApi({
      sync: vi.fn(async () => ({
        results: [{ id: G1, status: "error" as const, reason: "invalid" }],
      })),
    });
    const { store, engine } = makeEngine(api);
    await store.putGig(G1, { status: "lead", location: "local edit" });

    await engine.drain();

    expect(await store.pendingCount()).toBe(0);
    expect(api.getGig).toHaveBeenCalledWith(G1);
    const gig = await store.getGig(G1);
    expect(gig).not.toBeNull();
    expect(gig?.location).toBe("server copy");
  });

  it("on error result for a delete: drops the poison op without fetching a server copy", async () => {
    // There is no upload to revert on a rejected delete, and the row
    // this device wants gone may not even exist server-side to fetch
    // back — refreshFromServer is only for upserts.
    const api = stubApi({
      sync: vi.fn(async () => ({
        results: [{ id: G1, status: "error" as const, reason: "invalid" }],
      })),
    });
    const { store, engine } = makeEngine(api);
    await store.putGig(G1, { status: "lead" });
    for (const op of await store.pendingOps()) await store.deleteOp(op.opKey);
    await store.removeGig(G1);

    await engine.drain();

    expect(await store.pendingCount()).toBe(0);
    expect(api.getGig).not.toHaveBeenCalled();
  });

  it("keeps ops untouched when the network fails", async () => {
    const api = stubApi({
      sync: vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    });
    const { store, engine } = makeEngine(api);
    await store.putGig(G1, { status: "lead" });

    await engine.drain();

    expect(await store.pendingCount()).toBe(1);
  });

  it("no-ops cleanly with an empty outbox", async () => {
    const api = stubApi();
    const { engine } = makeEngine(api);
    await engine.drain();
    expect(api.sync).not.toHaveBeenCalled();
  });
});

describe("SyncEngine.pull", () => {
  it("adopts newer server rows when nothing is pending", async () => {
    const api = stubApi({ listGigs: vi.fn(async () => [serverGig()]) });
    const { store, engine } = makeEngine(api);

    await engine.pull();

    expect((await store.getGig(G1))?.location).toBe("server copy");
  });

  it("never clobbers a record with a pending op", async () => {
    const api = stubApi({
      listGigs: vi.fn(async () => [serverGig({ location: "server copy" })]),
    });
    const { store, engine } = makeEngine(api, () => 5);
    await store.putGig(G1, { status: "lead", location: "unsent local edit" });

    await engine.pull();

    expect((await store.getGig(G1))?.location).toBe("unsent local edit");
  });

  it("removes local rows the server no longer has (when not pending)", async () => {
    const api = stubApi({ listGigs: vi.fn(async () => []) });
    const { store, engine } = makeEngine(api);
    await store.applyServerRecord("gig", serverGig()); // previously synced

    await engine.pull();

    expect(await store.getGig(G1)).toBeNull();
  });

  it("pulls service rows from the server", async () => {
    const SVC = "66666666-6666-4666-8666-666666666666";
    const api = stubApi({
      listServices: vi.fn(async () => [
        {
          id: SVC,
          gigId: G1,
          description: "server service",
          amountOfferedCents: 100,
          amountPaidCents: null,
          paymentId: null,
          isCompleted: false,
          createdAt: 1,
          modifiedAt: 2,
        },
      ]),
    });
    const { store, engine } = makeEngine(api);

    await engine.pull();

    expect((await store.getService(SVC))?.description).toBe("server service");
  });

  it("keeps locally-created rows awaiting their first sync", async () => {
    const api = stubApi({ listGigs: vi.fn(async () => []) });
    const { store, engine } = makeEngine(api);
    await store.putGig(G1, { status: "lead" }); // pending op exists

    await engine.pull();

    expect(await store.getGig(G1)).not.toBeNull();
  });
});

describe("SyncEngine restart persistence", () => {
  it("start() drains ops persisted by a previous app session", async () => {
    // Session 1: user edits offline, app is killed before any drain.
    const userId = `restart-${++seq}`;
    const session1 = new LocalStore(openUserDb(userId), () => 1000);
    await session1.putGig(G1, { status: "lead" });

    // Session 2: fresh store + engine over the same DB — app restart.
    const api = stubApi();
    const session2 = new LocalStore(openUserDb(userId), () => 2000);
    const engine = new SyncEngine(session2, api, {
      schedule: (fn) => {
        void fn();
        return () => undefined;
      },
      isOnline: () => true,
      events: null,
    });

    engine.start();
    await vi.waitFor(async () => {
      expect(await session2.pendingCount()).toBe(0);
    });
    expect(api.sync).toHaveBeenCalledTimes(1);
    engine.stop();
  });

  it("start() while offline surfaces the persisted pending count without draining", async () => {
    const userId = `restart-${++seq}`;
    const session1 = new LocalStore(openUserDb(userId), () => 1000);
    await session1.putGig(G1, { status: "lead" });

    const api = stubApi();
    const engine = new SyncEngine(new LocalStore(openUserDb(userId)), api, {
      schedule: (fn) => {
        void fn();
        return () => undefined;
      },
      isOnline: () => false,
      events: null,
    });

    engine.start();
    await vi.waitFor(() => {
      expect(engine.getState().pendingCount).toBe(1);
    });
    expect(engine.getState().online).toBe(false);
    expect(api.sync).not.toHaveBeenCalled();
    engine.stop();
  });
});

/**
 * The failure path.
 *
 * start() used to perform exactly one sync, and a pull that failed
 * logged "will retry" and then did nothing at all — the next attempt
 * could only come from a local edit or an `online` event. A user whose
 * FIRST pull failed (token expired mid-flight, flaky connection at app
 * start, cold worker) was left looking at an empty app with no way back
 * that they could reasonably be expected to find.
 */
describe("SyncEngine retry", () => {
  it("retries a failed first pull until it lands", async () => {
    let attempt = 0;
    const api = stubApi({
      listGigs: vi.fn(async () => {
        attempt += 1;
        if (attempt === 1) throw new ApiError(401, "session expired");
        return [serverGig()];
      }),
    });
    const { store, engine } = makeEngine(api, () => 1000, { retryBaseMs: 1 });

    engine.start();

    await vi.waitFor(async () => {
      expect((await store.getGig(G1))?.location).toBe("server copy");
    });
    expect(api.listGigs).toHaveBeenCalledTimes(2);
    expect(engine.getState()).toMatchObject({ failedAttempts: 0, stalled: false });
    engine.stop();
  });

  it("retries a failed drain too, leaving the ops queued meanwhile", async () => {
    let attempt = 0;
    const api = stubApi({
      sync: vi.fn(async (ops: SyncOp[]) => {
        attempt += 1;
        if (attempt === 1) throw new TypeError("Failed to fetch");
        return { results: ops.map((o) => ({ id: o.id, status: "applied" as const })) };
      }),
    });
    const { store, engine } = makeEngine(api, () => 1000, { retryBaseMs: 1 });
    await store.putGig(G1, { status: "lead" });

    engine.start();

    await vi.waitFor(async () => {
      expect(await store.pendingCount()).toBe(0);
    });
    expect(api.sync).toHaveBeenCalledTimes(2);
    engine.stop();
  });

  it("backs off exponentially and gives up after a bounded count", async () => {
    const api = stubApi({ listGigs: rejects() });
    const { engine, delays } = makeEngine(api, () => 1000, {
      retryBaseMs: 10,
      maxRetries: 3,
    });

    engine.start();

    await vi.waitFor(() => {
      expect(engine.getState().stalled).toBe(true);
    });
    // One initial attempt plus exactly maxRetries retries — a failing
    // server must not be hammered forever.
    expect(api.listGigs).toHaveBeenCalledTimes(4);
    expect(delays).toEqual([10, 20, 40]);
    expect(engine.getState().failedAttempts).toBe(4);
    engine.stop();
  });

  it("does not burn retries while the browser reports itself offline", async () => {
    const api = stubApi({ listGigs: rejects() });
    const { engine, delays } = makeEngine(api, () => 1000, {
      isOnline: () => false,
      retryBaseMs: 10,
    });

    // start() skips the sync while offline, so drive one directly —
    // this is the "went offline mid-sync" case.
    await engine.syncNow();

    // The offline badge already explains this, and `online` fires a
    // fresh sync; spending the budget here would exhaust it before the
    // connection is even back.
    expect(delays).toEqual([]);
    expect(engine.getState().stalled).toBe(false);
  });

  it("retryNow restarts the ladder after the engine has given up", async () => {
    const api = stubApi({ listGigs: rejects() });
    const { engine, delays } = makeEngine(api, () => 1000, {
      retryBaseMs: 10,
      maxRetries: 1,
    });

    engine.start();
    await vi.waitFor(() => {
      expect(engine.getState().stalled).toBe(true);
    });
    expect(delays).toEqual([10]);

    await engine.retryNow();

    // Back to the first rung, not stuck at the exhausted one.
    expect(delays).toEqual([10, 10]);
    engine.stop();
  });

  it("only one sync runs at a time", async () => {
    let inFlight = 0;
    let overlapped = false;
    const api = stubApi({
      listGigs: vi.fn(async () => {
        inFlight += 1;
        if (inFlight > 1) overlapped = true;
        await Promise.resolve();
        inFlight -= 1;
        return [];
      }),
    });
    const { engine } = makeEngine(api);

    await Promise.all([engine.syncNow(), engine.syncNow(), engine.syncNow()]);

    expect(overlapped).toBe(false);
  });
});

describe("SyncEngine state + triggers", () => {
  it("notifyLocalChange schedules a drain and updates pendingCount", async () => {
    const api = stubApi();
    const { store, engine } = makeEngine(api);
    await store.putGig(G1, { status: "lead" });

    await engine.notifyLocalChange();
    await vi.waitFor(async () => {
      expect(await store.pendingCount()).toBe(0);
    });
    expect(engine.getState().pendingCount).toBe(0);
  });

  it("resets the failure state once a sync gets through", async () => {
    const api = stubApi({ listGigs: rejects() });
    const { engine } = makeEngine(api, () => 1000, {
      retryBaseMs: 1,
      maxRetries: 2,
    });

    engine.start();
    await vi.waitFor(() => {
      expect(engine.getState().stalled).toBe(true);
    });

    (api.listGigs as ReturnType<typeof vi.fn>).mockResolvedValue([serverGig()]);
    await engine.retryNow();

    expect(engine.getState()).toMatchObject({ stalled: false, failedAttempts: 0 });
    engine.stop();
  });

  it("exposes online state and notifies subscribers", async () => {
    const api = stubApi();
    const { engine } = makeEngine(api);
    const seen: boolean[] = [];
    engine.subscribe(() => seen.push(engine.getState().syncing));

    await engine.drain();

    expect(engine.getState().online).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
  });
});

// ── Phase 4: payments and allocations over the wire ────────────────

const P1 = "44444444-4444-4444-8444-444444444444";
const SERVER_ALLOC = "88888888-8888-4888-8888-888888888888";

/**
 * A miniature of the server's money rules — enough of
 * services/payment-invariants.ts and repos/allocations.ts to make the
 * ordering hazards real rather than assumed:
 *
 *  - an allocation may not exceed the payment it splits (over-allocation),
 *  - a payment may not shrink below what is allocated to it (I4),
 *  - an allocation needs its payment to exist,
 *  - a legacy `gigId` on a payment write is translated into a single
 *    full-amount allocation, unless the payment already carries a split.
 *
 * The messages are the server's own, so a test asserting on one is
 * asserting on the contract and not on a paraphrase of it.
 */
class FakeMoneyServer {
  readonly payments = new Map<
    string,
    { amountCents: number; gigId: string | null; confirmationR2Key?: string }
  >();
  readonly allocations = new Map<
    string,
    { paymentId: string; gigId: string; amountCents: number }
  >();
  /** Every batch posted, in order — the retry pass shows up here. */
  readonly batches: SyncOp[][] = [];
  /**
   * The R2 bucket, keyed the way backend/src/routes/payments.ts keys
   * it, holding what was actually PUT. This is what makes "the photo
   * reached the server" an assertion about bytes rather than about the
   * queue having been emptied.
   */
  readonly objects = new Map<string, { contentType: string; text: string }>();
  /** Flip to make every call fail the way a dead link fails: no status,
   *  no response, nothing applied. */
  offline = false;
  /** Payments whose confirmation PUT should be refused, and with what
   *  status — per payment, so one bad file can be shown not to take
   *  the queue down with it. */
  readonly refuse = new Map<string, number>();

  readonly sync = async (ops: SyncOp[]): Promise<{ results: SyncOpResult[] }> => {
    if (this.offline) throw new TypeError("Failed to fetch");
    this.batches.push(ops);
    return { results: ops.map((op) => this.apply(op)) };
  };

  /** The PUT /:id/confirmation route, including its 404 — the bytes
   *  have nowhere to go until D1 knows the payment. */
  readonly uploadConfirmation = async (
    id: string,
    file: Blob,
  ): Promise<{ confirmationR2Key: string }> => {
    if (this.offline) throw new TypeError("Failed to fetch");
    const refusal = this.refuse.get(id);
    if (refusal !== undefined) {
      throw new ApiError(refusal, "confirmation upload failed");
    }
    const row = this.payments.get(id);
    if (row === undefined) throw new ApiError(404, "not found");
    const key = `u/dev/payments/${id}/confirmation`;
    this.objects.set(key, { contentType: file.type, text: await file.text() });
    row.confirmationR2Key = key;
    return { confirmationR2Key: key };
  };

  /** The payment list as GET /api/payments would answer it, so a full
   *  `syncNow` can pull without the follow-up deleting what the drain
   *  just created. */
  paymentRows(): Payment[] {
    return [...this.payments.entries()].map(([id, row]) => ({
      id,
      gigId: row.gigId,
      clientId: null,
      amountCents: row.amountCents,
      paidAt: null,
      confirmationR2Key: row.confirmationR2Key ?? null,
      notes: null,
      createdAt: 1,
      modifiedAt: 1,
    }));
  }

  allocationsFor(paymentId: string): { id: string; amountCents: number; gigId: string }[] {
    return [...this.allocations.entries()]
      .filter(([, a]) => a.paymentId === paymentId)
      .map(([id, a]) => ({ id, amountCents: a.amountCents, gigId: a.gigId }));
  }

  private apply(op: SyncOp): SyncOpResult {
    const applied = { id: op.id, status: "applied" as const };
    if (op.op === "delete") {
      if (op.entity === "payment") {
        for (const [id, a] of this.allocations) {
          if (a.paymentId === op.id) this.allocations.delete(id);
        }
        this.payments.delete(op.id);
      }
      if (op.entity === "allocation") this.allocations.delete(op.id);
      return applied;
    }
    if (op.entity === "payment") {
      const payload = op.payload as { amountCents: number; gigId?: string | null };
      const current = this.allocationsFor(op.id);
      // The compat path resizes every allocation itself, so I4 has
      // nothing stale to catch when it is about to run.
      const gigIdWillReplace = payload.gigId != null && current.length <= 1;
      const allocated = current.reduce((sum, a) => sum + a.amountCents, 0);
      if (!gigIdWillReplace && allocated > payload.amountCents) {
        return {
          id: op.id,
          status: "error",
          reason: "amountCents is less than the payment's allocated total",
        };
      }
      this.payments.set(op.id, {
        amountCents: payload.amountCents,
        gigId: payload.gigId ?? null,
      });
      if (gigIdWillReplace) {
        for (const a of current) this.allocations.delete(a.id);
        this.allocations.set(`srv-${op.id}`, {
          paymentId: op.id,
          gigId: payload.gigId!,
          amountCents: payload.amountCents,
        });
      }
      return applied;
    }
    if (op.entity === "allocation") {
      const payload = op.payload as {
        paymentId: string;
        gigId: string;
        amountCents: number;
      };
      const payment = this.payments.get(payload.paymentId);
      if (payment === undefined) {
        return {
          id: op.id,
          status: "error",
          reason: "paymentId does not reference your payment",
        };
      }
      const others = this.allocationsFor(payload.paymentId)
        .filter((a) => a.id !== op.id)
        .reduce((sum, a) => sum + a.amountCents, 0);
      if (others + payload.amountCents > payment.amountCents) {
        return { id: op.id, status: "error", reason: "allocations exceed the payment" };
      }
      this.allocations.set(op.id, { ...payload });
      return applied;
    }
    return applied;
  }
}

function moneyApi(server: FakeMoneyServer): SyncApi {
  return stubApi({
    sync: server.sync,
    uploadPaymentConfirmation: server.uploadConfirmation,
    listPayments: vi.fn(async () => {
      if (server.offline) throw new TypeError("Failed to fetch");
      return server.paymentRows();
    }),
    listAllocations: vi.fn(async () => {
      if (server.offline) throw new TypeError("Failed to fetch");
      return [...server.allocations.entries()].map(([id, a]) => ({
        id,
        ...a,
        createdAt: 1,
        modifiedAt: 1,
      }));
    }),
    getPayment: vi.fn(async (id: string) => {
      const row = server.payments.get(id);
      if (row === undefined) throw new ApiError(404, "not found");
      return {
        id,
        gigId: row.gigId,
        clientId: null,
        amountCents: row.amountCents,
        paidAt: null,
        confirmationR2Key: null,
        notes: null,
        createdAt: 1,
        modifiedAt: 1,
      } satisfies Payment;
    }),
    getAllocation: vi.fn(async (id: string) => {
      const row = server.allocations.get(id);
      if (row === undefined) throw new ApiError(404, "not found");
      return { id, ...row, createdAt: 1, modifiedAt: 1 } satisfies Allocation;
    }),
  });
}

describe("SyncEngine allocations", () => {
  it("pulls allocations, and drops ones deleted elsewhere", async () => {
    const server: Allocation[] = [
      { id: SERVER_ALLOC, paymentId: P1, gigId: G1, amountCents: 5000, createdAt: 1, modifiedAt: 2 },
    ];
    const api = stubApi({ listAllocations: vi.fn(async () => server) });
    const { store, engine } = makeEngine(api);

    await engine.pull();
    expect((await store.getAllocation(SERVER_ALLOC))?.amountCents).toBe(5000);

    server.length = 0;
    await engine.pull();
    expect(await store.getAllocation(SERVER_ALLOC)).toBeNull();
  });

  it("lands a payment and its first allocation together, whatever order the outbox is in", async () => {
    // A payment and the allocation that says what it paid for are
    // created in one save, so they reach the server in one batch — and
    // the allocation is meaningless until the payment exists. Nothing
    // about the outbox guarantees which comes first (both are queued at
    // the same millisecond, and Dexie breaks that tie on the op key,
    // where "allocation:" sorts ahead of "payment:").
    const server = new FakeMoneyServer();
    const { store, engine } = makeEngine(moneyApi(server));
    await store.putPayment(P1, { gigId: G1, amountCents: 15000 });

    await engine.drain();

    expect(server.payments.get(P1)?.amountCents).toBe(15000);
    expect(server.allocationsFor(P1)).toEqual([
      expect.objectContaining({ gigId: G1, amountCents: 15000 }),
    ]);
    expect(await store.pendingCount()).toBe(0);
  });

  it("MIGRATION: shrinking an OLD client's payment moves its server-made allocation with it", async () => {
    // The payment came from a build that predates allocations: the
    // server holds a gigId and the single allocation it minted itself.
    // Correcting the amount downwards is the case that cannot be
    // ordered away — the payment write is refused while the old
    // allocation still over-claims it, and the allocation write would be
    // refused first if the payment had grown instead.
    const server = new FakeMoneyServer();
    server.payments.set(P1, { amountCents: 15000, gigId: G1 });
    server.allocations.set(SERVER_ALLOC, {
      paymentId: P1,
      gigId: G1,
      amountCents: 15000,
    });
    const { store, engine } = makeEngine(moneyApi(server));
    await store.applyServerRecord("payment", {
      id: P1,
      gigId: G1,
      clientId: null,
      amountCents: 15000,
      paidAt: null,
      confirmationR2Key: null,
      notes: null,
      createdAt: 1,
      modifiedAt: 1,
    } satisfies Payment);
    await store.applyServerRecord("allocation", {
      id: SERVER_ALLOC,
      paymentId: P1,
      gigId: G1,
      amountCents: 15000,
      createdAt: 1,
      modifiedAt: 1,
    } satisfies Allocation);

    await store.putPayment(P1, { gigId: G1, amountCents: 5000 });
    await engine.drain();

    expect(server.payments.get(P1)?.amountCents).toBe(5000);
    // The same row, moved — not a second one, and not the old figure.
    expect(server.allocationsFor(P1)).toEqual([
      { id: SERVER_ALLOC, gigId: G1, amountCents: 5000 },
    ]);
    // …and the legacy column is empty now: this build stopped sending it.
    expect(server.payments.get(P1)?.gigId).toBeNull();
    expect(await store.pendingCount()).toBe(0);
  });

  it("raising a payment and its allocation together lands too", async () => {
    // The mirror image of the shrink, and it needs the opposite order.
    const server = new FakeMoneyServer();
    server.payments.set(P1, { amountCents: 15000, gigId: null });
    server.allocations.set(SERVER_ALLOC, {
      paymentId: P1,
      gigId: G1,
      amountCents: 15000,
    });
    const { store, engine } = makeEngine(moneyApi(server));
    await store.applyServerRecord("payment", {
      id: P1,
      gigId: null,
      clientId: null,
      amountCents: 15000,
      paidAt: null,
      confirmationR2Key: null,
      notes: null,
      createdAt: 1,
      modifiedAt: 1,
    } satisfies Payment);
    await store.applyServerRecord("allocation", {
      id: SERVER_ALLOC,
      paymentId: P1,
      gigId: G1,
      amountCents: 15000,
      createdAt: 1,
      modifiedAt: 1,
    } satisfies Allocation);

    await store.putPayment(P1, { gigId: G1, amountCents: 20000 });
    await engine.drain();

    expect(server.payments.get(P1)?.amountCents).toBe(20000);
    expect(server.allocationsFor(P1)).toEqual([
      { id: SERVER_ALLOC, gigId: G1, amountCents: 20000 },
    ]);
    expect(await store.pendingCount()).toBe(0);
  });

  it("MIGRATION: an outbox op queued by the OLD build drains through the server's compat path", async () => {
    // Written by a build that predates allocations and left unsent. The
    // engine forwards it exactly as queued — gigId and all — and the
    // server turns it into the single allocation it always did. Nothing
    // in the new client strips or rewrites it.
    const server = new FakeMoneyServer();
    const { store, db, engine } = makeEngine(moneyApi(server));
    await store.applyServerRecord("payment", {
      id: P1,
      gigId: G1,
      clientId: null,
      amountCents: 15000,
      paidAt: null,
      confirmationR2Key: null,
      notes: null,
      createdAt: 1,
      modifiedAt: 1,
    } satisfies Payment);
    await queueLegacyPaymentOp(db, P1, {
      gigId: G1,
      amountCents: 15000,
      paidAt: null,
      notes: null,
    });

    await engine.drain();

    expect(server.batches[0]?.[0]?.payload).toEqual({
      gigId: G1,
      amountCents: 15000,
      paidAt: null,
      notes: null,
    });
    expect(server.allocationsFor(P1)).toEqual([
      { id: `srv-${P1}`, gigId: G1, amountCents: 15000 },
    ]);
    expect(await store.pendingCount()).toBe(0);
  });

  it("MIGRATION: a legacy op cannot collapse a split made on this build", async () => {
    // Same queued op, but the payment has since been split across two
    // gigs from another device. The server's guard (>1 allocation) is
    // what stops the stale gigId from reassigning the whole payment.
    const server = new FakeMoneyServer();
    server.payments.set(P1, { amountCents: 15000, gigId: null });
    server.allocations.set("a-1", { paymentId: P1, gigId: G1, amountCents: 10000 });
    server.allocations.set("a-2", { paymentId: P1, gigId: C1, amountCents: 5000 });
    const { db, engine } = makeEngine(moneyApi(server));
    await queueLegacyPaymentOp(db, P1, {
      gigId: G1,
      amountCents: 15000,
      paidAt: null,
      notes: null,
    });

    await engine.drain();

    expect(server.allocationsFor(P1)).toEqual([
      { id: "a-1", gigId: G1, amountCents: 10000 },
      { id: "a-2", gigId: C1, amountCents: 5000 },
    ]);
  });
});

// ── Phase 4 Task 10: the confirmation photo queue ──────────────────

const A1 = "55555555-5555-4555-8555-555555555555";
const P2 = "99999999-9999-4999-8999-999999999999";

/**
 * The queue's `OutboxPayload` problem, and the test that stands in for
 * the guard it cannot have.
 *
 * `OutboxPayload<T> = Required<T>` exists because a field was once
 * added to a record and not to the payload, and the data silently never
 * arrived — nothing failed, nothing was logged, and the loss surfaced
 * months later. A blob queue has exactly that failure mode: the photo
 * is written locally, the screen shows it, and whether it ever leaves
 * the device is invisible from anywhere the compiler can look. No
 * `Required<T>` can help — a Blob has no fields to require.
 *
 * So the guard is runtime, and it is these tests. Every one of them
 * asserts on what the SERVER ended up holding, never on the queue
 * having been emptied: an implementation that deleted the row without
 * uploading anything would empty the queue just as thoroughly as one
 * that worked.
 */
describe("SyncEngine photo queue", () => {
  it("carries a photo queued offline to the server — the bytes, not just the row", async () => {
    const server = new FakeMoneyServer();
    let online = false;
    server.offline = true;
    const { store, engine } = makeEngine(moneyApi(server), () => 1000, {
      isOnline: () => online,
    });

    // A payment recorded on a job site with no signal: the record and
    // its split go to the outbox, the photo to its own queue.
    await store.putPayment(P1, { amountCents: 15000 });
    await store.putAllocation(A1, { paymentId: P1, gigId: G1, amountCents: 15000 });
    const chosen = new Blob(["the-bytes-of-a-bank-confirmation"], {
      type: "image/jpeg",
    });
    expect((await store.queueImage(P1, chosen)).queued).toBe(true);

    await engine.syncNow();

    // Nothing reached anything, and the badge says the device is
    // holding three things — payment, allocation, photo.
    expect(server.payments.size).toBe(0);
    expect(server.objects.size).toBe(0);
    expect(await store.pendingCount()).toBe(3);
    expect(engine.getState().pendingCount).toBe(3);

    server.offline = false;
    online = true;
    await engine.syncNow();

    // The money arrived…
    expect(server.payments.get(P1)?.amountCents).toBe(15000);
    // …and so did the PHOTO. Read back off the server's own bucket:
    // these are the bytes that were chosen, under the key the route
    // derives, with the content type they were picked with.
    const key = `u/dev/payments/${P1}/confirmation`;
    expect(server.objects.get(key)).toEqual({
      contentType: "image/jpeg",
      text: "the-bytes-of-a-bank-confirmation",
    });
    // The device stopped holding it, the record names the key so the
    // screen can stop saying "waiting", and nothing is pending.
    expect(await store.queuedImage(P1)).toBeNull();
    expect((await store.getPayment(P1))?.confirmationR2Key).toBe(key);
    expect(await store.pendingCount()).toBe(0);
  });

  it("uploads only after the payment itself has landed", async () => {
    // The ordering hazard this queue lives with. The upload endpoint
    // 404s on a payment D1 has never heard of, and a 404 is permanent
    // here — so a photo attached to a payment created in the same
    // offline session would be destroyed on its first attempt if the
    // outbox had not gone first.
    const server = new FakeMoneyServer();
    const { store, engine } = makeEngine(moneyApi(server));
    await store.putPayment(P1, { amountCents: 15000 });
    await store.queueImage(P1, new Blob(["proof"], { type: "image/png" }));

    await engine.syncNow();

    expect(server.objects.get(`u/dev/payments/${P1}/confirmation`)?.text).toBe("proof");
    expect((await store.queuedImage(P1))).toBeNull();
  });

  it("does not even TRY the upload when the outbox could not reach the server", async () => {
    // The same ordering seen from the failing side, and the reason the
    // guard is `drained ? … : false` rather than an unconditional call.
    // A payment created offline is not on the server, so an upload
    // attempted anyway would 404 — a status this queue calls permanent
    // — and the photo would be destroyed by a link failure that was
    // about to end. The assertion is therefore that the call was never
    // MADE, not merely that the row survived: a 404 handled some other
    // way would still leave a tombstone here.
    const server = new FakeMoneyServer();
    server.offline = true;
    const api = moneyApi(server);
    const upload = vi.fn(server.uploadConfirmation);
    api.uploadPaymentConfirmation = upload;
    const { store, engine } = makeEngine(api, () => 1000, {
      isOnline: () => false,
    });
    await store.putPayment(P1, { amountCents: 15000 });
    await store.queueImage(P1, new Blob(["proof"], { type: "image/png" }));

    await engine.syncNow();

    expect(upload).not.toHaveBeenCalled();
    expect((await store.queuedImage(P1))?.failedReason).toBeNull();
    expect((await store.queuedImage(P1))?.attempts).toBe(0);
    expect(await store.queuedImagesToUpload()).toHaveLength(1);
  });

  it("keeps a photo through a failure that is about the link, not the file", async () => {
    const server = new FakeMoneyServer();
    server.payments.set(P1, { amountCents: 15000, gigId: null });
    let online = true;
    const api = moneyApi(server);
    api.uploadPaymentConfirmation = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const { store, engine } = makeEngine(api, () => 1000, {
      isOnline: () => online,
      // One rung of the ladder, so the immediate scheduler in makeEngine
      // does not recurse for the whole default budget.
      maxRetries: 0,
    });
    await store.applyServerRecord("payment", {
      id: P1,
      gigId: null,
      clientId: null,
      amountCents: 15000,
      paidAt: null,
      confirmationR2Key: null,
      notes: null,
      createdAt: 1,
      modifiedAt: 1,
    } satisfies Payment);
    await store.queueImage(P1, new Blob(["proof"], { type: "image/png" }));

    await engine.syncNow();

    const still = await store.queuedImage(P1);
    expect(still?.failedReason).toBeNull();
    expect(still?.attempts).toBe(1);
    expect(await store.pendingCount()).toBe(1);
    // A transient failure is a failed sync, which is what asks for
    // another attempt — and with the budget spent, says so.
    expect(engine.getState().stalled).toBe(true);

    // Second chance, and it works: nothing about the first attempt made
    // the photo unusable.
    online = true;
    api.uploadPaymentConfirmation = server.uploadConfirmation;
    await engine.retryNow();

    expect(server.objects.get(`u/dev/payments/${P1}/confirmation`)?.text).toBe("proof");
    expect(await store.pendingCount()).toBe(0);
  });

  it("gives up on a photo the server will never take, and leaves a reason behind", async () => {
    // The other half of the bargain. An image that retries forever is
    // as bad as one that vanishes: this one stops being retried, and
    // still says what happened.
    const server = new FakeMoneyServer();
    server.payments.set(P1, { amountCents: 15000, gigId: null });
    server.refuse.set(P1, 413);
    const { store, engine } = makeEngine(moneyApi(server));
    await store.queueImage(P1, new Blob(["far-too-many-bytes"], { type: "image/jpeg" }));

    await engine.syncNow();

    const dead = await store.queuedImage(P1);
    expect(dead?.failedReason).toBe("the file was too large for the server");
    expect(dead?.blob).toBeNull();
    // Not counted as pending, and never offered again — the badge is
    // not left claiming work that will never happen.
    expect(await store.pendingCount()).toBe(0);
    expect(await store.queuedImagesToUpload()).toEqual([]);

    // …and giving up is a COMPLETED outcome, not a failed sync. Calling
    // it a failure would put the engine into a backoff it can never
    // leave, since the next attempt would refuse identically.
    expect(engine.getState().stalled).toBe(false);
    expect(engine.getState().failedAttempts).toBe(0);
  });

  it("a refused photo does not wedge the queue behind it", async () => {
    // The outbox rule ("a poison op must never wedge the queue"),
    // applied to bytes. The 415 is one bad file, not a broken server.
    const server = new FakeMoneyServer();
    server.payments.set(P1, { amountCents: 15000, gigId: null });
    server.payments.set(P2, { amountCents: 5000, gigId: null });
    let now = 100;
    const { store, engine } = makeEngine(moneyApi(server), () => now);
    await store.queueImage(P1, new Blob(["a-video-by-mistake"], { type: "video/mp4" }));
    now = 200;
    await store.queueImage(P2, new Blob(["a-real-receipt"], { type: "image/jpeg" }));
    // Only the OLDER one is refused, so it is first in line and the
    // good one is genuinely behind it.
    server.refuse.set(P1, 415);

    await engine.syncNow();

    expect((await store.queuedImage(P1))?.failedReason).toBe(
      "the server does not accept that kind of file",
    );
    // One pass, and the receipt behind the bad file is on the server.
    expect(server.objects.get(`u/dev/payments/${P2}/confirmation`)?.text).toBe(
      "a-real-receipt",
    );
    expect(await store.pendingCount()).toBe(0);
  });
});
