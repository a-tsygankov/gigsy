import "fake-indexeddb/auto";
import { describe, it, expect, vi } from "vitest";
import { openUserDb } from "./db.ts";
import { LocalStore } from "./local-store.ts";
import {
  SyncEngine,
  type SyncApi,
  type SyncEngineOptions,
} from "./sync-engine.ts";
import { ApiError, type SyncOp } from "./api.ts";
import type { Gig } from "./types.ts";

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
    getGig: vi.fn(async () => serverGig()),
    getClient: unexpected as never,
    getExpense: unexpected as never,
    getService: unexpected as never,
    getPayment: unexpected as never,
    ...overrides,
  };
}

function makeEngine(
  api: SyncApi,
  clockValue = () => 1000,
  options: SyncEngineOptions = {},
) {
  const store = new LocalStore(openUserDb(`sync-${++seq}`), clockValue);
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
  return { store, engine, api, delays };
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
