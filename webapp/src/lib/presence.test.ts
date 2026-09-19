import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PresenceTracker,
  type PresenceDeps,
  type PresenceInterval,
} from "./presence.ts";

/** A localStorage that behaves, and one that does not. */
function memoryStorage(): PresenceDeps["storage"] & { dump(): Record<string, string> } {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    dump: () => Object.fromEntries(map),
  };
}

function hostileStorage(): PresenceDeps["storage"] {
  return {
    getItem: () => {
      throw new Error("storage disabled");
    },
    setItem: () => {
      throw new Error("storage disabled");
    },
    removeItem: () => {
      throw new Error("storage disabled");
    },
  };
}

interface Harness {
  tracker: PresenceTracker;
  sent: PresenceInterval[][];
  setNow: (ms: number) => void;
  storage: ReturnType<typeof memoryStorage>;
  fail: (should: boolean) => void;
  setOnline: (v: boolean) => void;
  setSignedIn: (v: boolean) => void;
}

function harness(start = 1_000_000): Harness {
  let now = start;
  let online = true;
  let signedIn = true;
  let failing = false;
  const sent: PresenceInterval[][] = [];
  const storage = memoryStorage();

  let seq = 0;
  const tracker = new PresenceTracker({
    now: () => now,
    newId: () => `id-${++seq}`,
    storage,
    isOnline: () => online,
    isSignedIn: () => signedIn,
    send: async (intervals) => {
      if (failing) throw new Error("offline");
      sent.push(intervals);
    },
  });

  return {
    tracker,
    sent,
    storage,
    setNow: (ms) => (now = ms),
    fail: (should) => (failing = should),
    setOnline: (v) => (online = v),
    setSignedIn: (v) => (signedIn = v),
  };
}

describe("measuring an interval", () => {
  it("records the time between becoming visible and hidden", async () => {
    const h = harness();
    h.tracker.open();
    h.setNow(1_060_000);
    h.tracker.close();
    await h.tracker.flush();

    expect(h.sent).toEqual([
      [{ id: "id-1", startedAt: 1_000_000, endedAt: 1_060_000 }],
    ]);
  });

  it("ignores a flick shorter than a second", async () => {
    const h = harness();
    h.tracker.open();
    h.setNow(1_000_400);
    h.tracker.close();
    await h.tracker.flush();

    expect(h.sent).toEqual([]);
  });

  it("treats a second open as a no-op rather than restarting the clock", async () => {
    const h = harness();
    h.tracker.open();
    h.setNow(1_030_000);
    h.tracker.open(); // a stray focus event
    h.setNow(1_060_000);
    h.tracker.close();
    await h.tracker.flush();

    expect(h.sent[0]?.[0]?.startedAt).toBe(1_000_000);
  });

  it("closes only once, however many events report the departure", async () => {
    const h = harness();
    h.tracker.open();
    h.setNow(1_060_000);
    h.tracker.close();
    h.setNow(1_200_000);
    h.tracker.close(); // pagehide after visibilitychange
    await h.tracker.flush();

    expect(h.sent[0]).toHaveLength(1);
  });

  it("starts measuring as soon as the user signs in", async () => {
    // The app mounts signed-out, so the first open() is refused. If
    // nothing reopens on sign-in, the whole session goes unrecorded —
    // app-context subscribes to auth for exactly this reason.
    const h = harness();
    h.setSignedIn(false);
    h.tracker.open();
    expect(h.tracker.isOpen()).toBe(false);

    h.setSignedIn(true);
    h.tracker.open();
    expect(h.tracker.isOpen()).toBe(true);

    h.setNow(1_060_000);
    h.tracker.close();
    await h.tracker.flush();
    expect(h.sent[0]).toEqual([
      { id: "id-1", startedAt: 1_000_000, endedAt: 1_060_000 },
    ]);
  });

  it("records nothing at all for a signed-out user", async () => {
    const h = harness();
    h.setSignedIn(false);
    h.tracker.open();
    h.setNow(1_060_000);
    h.tracker.close();
    await h.tracker.flush();

    expect(h.tracker.isOpen()).toBe(false);
    expect(h.sent).toEqual([]);
  });
});

describe("surviving the app being killed", () => {
  it("closes an orphaned interval at its last heartbeat, not at reopen", async () => {
    const h = harness();
    h.tracker.open();
    h.setNow(1_030_000);
    h.tracker.beat();

    // The OS kills the app here. Hours pass; a new run starts.
    const next = new PresenceTracker({
      now: () => 9_000_000,
      storage: h.storage,
      isOnline: () => true,
      isSignedIn: () => true,
      newId: () => "id-recovered",
      send: async (intervals) => void h.sent.push(intervals),
    });
    next.recoverOrphan();
    await next.flush();

    // The pocket hours must not become screen time.
    expect(h.sent).toEqual([
      [{ id: "id-recovered", startedAt: 1_000_000, endedAt: 1_030_000 }],
    ]);
  });

  it("loses no more than one heartbeat of time", async () => {
    const h = harness();
    h.tracker.open();
    h.setNow(1_030_000);
    h.tracker.beat();
    h.setNow(1_055_000); // killed 25s after the last beat

    const next = new PresenceTracker({
      now: () => 2_000_000,
      storage: h.storage,
      isOnline: () => true,
      isSignedIn: () => true,
      newId: () => "id-recovered",
      send: async (intervals) => void h.sent.push(intervals),
    });
    next.recoverOrphan();
    await next.flush();

    const recovered = h.sent[0]![0]!;
    const lost = 1_055_000 - recovered.endedAt;
    expect(lost).toBeLessThanOrEqual(30_000);
  });

  it("has nothing to recover on a clean start", () => {
    const h = harness();
    h.tracker.recoverOrphan();
    expect(h.storage.dump()).toEqual({});
  });
});

describe("surviving being offline", () => {
  it("queues while offline and sends everything on reconnect", async () => {
    const h = harness();
    h.setOnline(false);

    h.tracker.open();
    h.setNow(1_060_000);
    h.tracker.close();
    await h.tracker.flush();
    expect(h.sent).toEqual([]);

    h.setNow(1_200_000);
    h.tracker.open();
    h.setNow(1_300_000);
    h.tracker.close();
    await h.tracker.flush();
    expect(h.sent).toEqual([]);

    // Back online: both intervals arrive with their ORIGINAL times.
    h.setOnline(true);
    await h.tracker.flush();
    expect(h.sent).toEqual([
      [
        { id: "id-1", startedAt: 1_000_000, endedAt: 1_060_000 },
        { id: "id-2", startedAt: 1_200_000, endedAt: 1_300_000 },
      ],
    ]);
  });

  it("keeps the queue when the send fails", async () => {
    const h = harness();
    h.fail(true);
    h.tracker.open();
    h.setNow(1_060_000);
    h.tracker.close();
    await h.tracker.flush();
    expect(h.sent).toEqual([]);

    h.fail(false);
    await h.tracker.flush();
    expect(h.sent[0]).toHaveLength(1);
  });

  it("does not resend what a previous flush already delivered", async () => {
    const h = harness();
    h.tracker.open();
    h.setNow(1_060_000);
    h.tracker.close();
    await h.tracker.flush();
    await h.tracker.flush();

    expect(h.sent).toHaveLength(1);
  });

  it("keeps an interval queued during an in-flight flush", async () => {
    // The bug this guards: clearing the queue outright after a send
    // eats anything enqueued while the request was on the wire.
    const h = harness();
    h.tracker.open();
    h.setNow(1_060_000);
    h.tracker.close();

    const inFlight = h.tracker.flush();
    h.setNow(1_100_000);
    h.tracker.open();
    h.setNow(1_200_000);
    h.tracker.close();
    await inFlight;

    await h.tracker.flush();
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]).toEqual([
      { id: "id-2", startedAt: 1_100_000, endedAt: 1_200_000 },
    ]);
  });
});

describe("signing out", () => {
  it("drops the queue so the next person does not inherit it", async () => {
    const h = harness();
    h.setOnline(false);
    h.tracker.open();
    h.setNow(1_060_000);
    h.tracker.close();

    h.tracker.discard();
    h.setOnline(true);
    await h.tracker.flush();

    expect(h.sent).toEqual([]);
    expect(h.storage.dump()).toEqual({});
  });
});

describe("when storage will not cooperate", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("still measures, and still reports, without throwing", async () => {
    const sent: PresenceInterval[][] = [];
    let now = 1_000_000;
    const tracker = new PresenceTracker({
      now: () => now,
      storage: hostileStorage(),
      isOnline: () => true,
      isSignedIn: () => true,
      send: async (intervals) => void sent.push(intervals),
    });

    expect(() => tracker.open()).not.toThrow();
    now = 1_060_000;
    expect(() => tracker.close()).not.toThrow();
    // Nothing can be persisted, so nothing can be flushed — but the
    // app is unharmed, which is the requirement.
    await expect(tracker.flush()).resolves.toBeUndefined();
    expect(sent).toEqual([]);
  });
});

describe("not counting the same time twice", () => {
  it("collapses concurrent flushes into one send", async () => {
    // Two listeners racing on one event produced two identical rows
    // the first time this ran in a browser. Screen time that is
    // double-counted looks plausible, which makes it worse than none.
    const h = harness();
    h.tracker.open();
    h.setNow(1_060_000);
    h.tracker.close();

    await Promise.all([h.tracker.flush(), h.tracker.flush(), h.tracker.flush()]);

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toHaveLength(1);
  });

  it("keeps an interval's id stable across a failed send", async () => {
    // The server ignores a repeat of an id it already stored, so the
    // id must survive the retry that makes that matter.
    const h = harness();
    h.fail(true);
    h.tracker.open();
    h.setNow(1_060_000);
    h.tracker.close();
    await h.tracker.flush();

    h.fail(false);
    await h.tracker.flush();
    expect(h.sent[0]?.[0]?.id).toBe("id-1");
  });
});
