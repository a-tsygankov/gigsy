import "fake-indexeddb/auto";
import { describe, it, expect, vi } from "vitest";
import { openUserDb } from "./db.ts";
import { LocalStore } from "./local-store.ts";
import { SyncEngine, type SyncApi } from "./sync-engine.ts";
import type { SyncOp } from "./api.ts";
import type { Gig } from "./types.ts";

let seq = 0;
const G1 = "11111111-1111-4111-8111-111111111111";
const C1 = "22222222-2222-4222-8222-222222222222";

function serverGig(overrides: Partial<Gig> = {}): Gig {
  return {
    id: G1,
    clientId: null,
    status: "paid",
    location: "server copy",
    dateTime: null,
    calendarEventId: null,
    amountOfferedCents: null,
    amountPaidCents: null,
    notes: null,
    source: "manual",
    createdAt: 1,
    modifiedAt: 9999,
    ...overrides,
  };
}

function stubApi(overrides: Partial<SyncApi> = {}): SyncApi {
  return {
    sync: vi.fn(async (ops: SyncOp[]) => ({
      results: ops.map((o) => ({ id: o.id, status: "applied" as const })),
    })),
    listGigs: vi.fn(async () => []),
    listClients: vi.fn(async () => []),
    listExpenses: vi.fn(async () => []),
    getGig: vi.fn(async () => serverGig()),
    getClient: vi.fn(async () => {
      throw new Error("unexpected");
    }),
    getExpense: vi.fn(async () => {
      throw new Error("unexpected");
    }),
    ...overrides,
  };
}

function makeEngine(api: SyncApi, clockValue = () => 1000) {
  const store = new LocalStore(openUserDb(`sync-${++seq}`), clockValue);
  const engine = new SyncEngine(store, api, {
    // Immediate scheduler — no timers in unit tests.
    schedule: (fn) => {
      void fn();
      return () => undefined;
    },
    isOnline: () => true,
  });
  return { store, engine, api };
}

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

  it("on error result: drops the poison op, keeps the local record", async () => {
    const api = stubApi({
      sync: vi.fn(async () => ({
        results: [{ id: G1, status: "error" as const, reason: "invalid" }],
      })),
    });
    const { store, engine } = makeEngine(api);
    await store.putGig(G1, { status: "lead" });

    await engine.drain();

    expect(await store.pendingCount()).toBe(0);
    expect(await store.getGig(G1)).not.toBeNull();
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
