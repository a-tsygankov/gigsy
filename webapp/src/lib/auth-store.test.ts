import { describe, it, expect, vi } from "vitest";
import { AuthManager, type AuthApi, type KVStorage } from "./auth-store.ts";

function memoryKV(initial: Record<string, string> = {}): KVStorage {
  const map = new Map(Object.entries(initial));
  return {
    get: async (k) => map.get(k) ?? null,
    set: async (k, v) => void map.set(k, v),
    del: async (k) => void map.delete(k),
    _dump: () => Object.fromEntries(map),
  } as KVStorage & { _dump(): Record<string, string> };
}

const USER = { id: "u1", email: "a@example.com" };

function stubApi(overrides: Partial<AuthApi> = {}): AuthApi {
  return {
    loginWithGoogle: async () => ({
      accessToken: "at-1",
      refreshToken: "rt-1",
      user: USER,
    }),
    refreshSession: async () => ({
      ok: true as const,
      tokens: { accessToken: "at-2", refreshToken: "rt-2" },
    }),
    ...overrides,
  };
}

const REJECTED = { ok: false as const, reason: "rejected" as const };
const UNREACHABLE = { ok: false as const, reason: "unreachable" as const };

function makeClock(start = 0) {
  let now = start;
  return { now: () => now, advance: (ms: number) => void (now += ms) };
}

describe("AuthManager", () => {
  it("signIn stores the refresh token and exposes the user", async () => {
    const kv = memoryKV();
    const auth = new AuthManager(stubApi(), kv, () => 0);

    await auth.signIn("google-id-token");

    expect(auth.getUser()).toEqual(USER);
    expect(await kv.get("gigsy.refreshToken")).toBe("rt-1");
    expect(await auth.getAccessToken()).toBe("at-1");
  });

  it("bootstrap restores a session from the stored refresh token", async () => {
    const kv = memoryKV({ "gigsy.refreshToken": "rt-old" });
    const refreshSession = vi.fn(async () => ({
      ok: true as const,
      tokens: { accessToken: "at-2", refreshToken: "rt-2" },
      user: USER,
    }));
    const auth = new AuthManager(stubApi({ refreshSession }), kv, () => 0);

    await auth.bootstrap();

    expect(refreshSession).toHaveBeenCalledWith("rt-old");
    expect(auth.isSignedIn()).toBe(true);
    // Rotation persisted.
    expect(await kv.get("gigsy.refreshToken")).toBe("rt-2");
  });

  it("bootstrap without a stored token stays signed out", async () => {
    const auth = new AuthManager(stubApi(), memoryKV(), () => 0);
    await auth.bootstrap();
    expect(auth.isSignedIn()).toBe(false);
  });

  it("bootstrap clears storage when the server rejects the refresh token", async () => {
    const kv = memoryKV({ "gigsy.refreshToken": "rt-dead" });
    const auth = new AuthManager(
      stubApi({ refreshSession: async () => REJECTED }),
      kv,
      () => 0,
    );

    await auth.bootstrap();

    expect(auth.isSignedIn()).toBe(false);
    expect(await kv.get("gigsy.refreshToken")).toBeNull();
  });

  // Reopening the app on a dead network must not look like a sign-out:
  // the ledger is local, so the app is fully usable offline. Only the
  // server saying "no" may destroy a session.
  it("bootstrap keeps the session and opens the app when the network is unreachable", async () => {
    const kv = memoryKV({
      "gigsy.refreshToken": "rt-good",
      "gigsy.user": JSON.stringify(USER),
    });
    const auth = new AuthManager(
      stubApi({ refreshSession: async () => UNREACHABLE }),
      kv,
      () => 0,
    );

    await auth.bootstrap();

    expect(auth.isSignedIn()).toBe(true);
    expect(auth.getUser()).toEqual(USER);
    // The token survives for the next attempt…
    expect(await kv.get("gigsy.refreshToken")).toBe("rt-good");
    // …but there is no usable access token until a refresh succeeds.
    expect(await auth.getAccessToken()).toBeNull();
  });

  it("bootstrap reports whether the session is fully live or offline", async () => {
    const offline = new AuthManager(
      stubApi({ refreshSession: async () => UNREACHABLE }),
      memoryKV({
        "gigsy.refreshToken": "rt",
        "gigsy.user": JSON.stringify(USER),
      }),
      () => 0,
    );
    expect(await offline.bootstrap()).toBe("offline");

    const live = new AuthManager(
      stubApi(),
      memoryKV({ "gigsy.refreshToken": "rt" }),
      () => 0,
    );
    expect(await live.bootstrap()).toBe("live");

    const out = new AuthManager(stubApi(), memoryKV(), () => 0);
    expect(await out.bootstrap()).toBe("signed-out");
  });

  // A 500 from the worker is not the user's session going bad.
  it("refresh keeps the session when the server is merely unreachable", async () => {
    const kv = memoryKV();
    const refreshSession = vi
      .fn<AuthApi["refreshSession"]>()
      .mockResolvedValue(UNREACHABLE);
    const clock = makeClock();
    const auth = new AuthManager(stubApi({ refreshSession }), kv, clock.now);
    await auth.signIn("idt");

    clock.advance(15 * 60 * 1000);
    expect(await auth.getAccessToken()).toBeNull();

    // Still signed in, token still on disk, ready to retry.
    expect(auth.isSignedIn()).toBe(true);
    expect(await kv.get("gigsy.refreshToken")).toBe("rt-1");
  });

  it("getAccessToken refreshes only after the freshness window", async () => {
    const clock = makeClock();
    const refreshSession = vi.fn(async () => ({
      ok: true as const,
      tokens: { accessToken: "at-2", refreshToken: "rt-2" },
    }));
    const auth = new AuthManager(
      stubApi({ refreshSession }),
      memoryKV(),
      clock.now,
    );
    await auth.signIn("idt");

    expect(await auth.getAccessToken()).toBe("at-1");
    expect(refreshSession).not.toHaveBeenCalled();

    clock.advance(15 * 60 * 1000); // past the 14-min freshness window
    expect(await auth.getAccessToken()).toBe("at-2");
    expect(refreshSession).toHaveBeenCalledTimes(1);
  });

  // Refresh tokens rotate and are consumed on use, so two concurrent
  // refreshes spend the same one-shot token — the loser gets a 401
  // that looks exactly like a dead session and signs the user out.
  // Startup hits this: bootstrap refreshes while the sync engine's
  // first (401ing) request triggers a refresh of its own.
  it("coalesces concurrent refreshes into a single token exchange", async () => {
    const refreshSession = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return { ok: true as const, tokens: { accessToken: "at-2", refreshToken: "rt-2" } };
    });
    const auth = new AuthManager(
      stubApi({ refreshSession }),
      memoryKV({ "gigsy.refreshToken": "rt-1" }),
      () => 0,
    );

    const results = await Promise.all([auth.refresh(), auth.refresh(), auth.refresh()]);

    expect(results).toEqual([true, true, true]);
    expect(refreshSession).toHaveBeenCalledTimes(1);
  });

  it("bootstrap shares the in-flight refresh with a concurrent caller", async () => {
    const refreshSession = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return { ok: true as const, tokens: { accessToken: "at-2", refreshToken: "rt-2" } };
    });
    const auth = new AuthManager(
      stubApi({ refreshSession }),
      memoryKV({
        "gigsy.refreshToken": "rt-1",
        "gigsy.user": JSON.stringify(USER),
      }),
      () => 0,
    );

    const [outcome] = await Promise.all([auth.bootstrap(), auth.refresh()]);

    expect(outcome).toBe("live");
    expect(refreshSession).toHaveBeenCalledTimes(1);
  });

  it("allows a fresh attempt once the in-flight one settles", async () => {
    const refreshSession = vi.fn(async () => ({
      ok: true as const,
      tokens: { accessToken: "at-2", refreshToken: "rt-2" },
    }));
    const auth = new AuthManager(
      stubApi({ refreshSession }),
      memoryKV({ "gigsy.refreshToken": "rt-1" }),
      () => 0,
    );

    await auth.refresh();
    await auth.refresh();

    expect(refreshSession).toHaveBeenCalledTimes(2);
  });

  it("signOut clears memory and storage", async () => {
    const kv = memoryKV();
    const auth = new AuthManager(stubApi(), kv, () => 0);
    await auth.signIn("idt");

    await auth.signOut();

    expect(auth.isSignedIn()).toBe(false);
    expect(await kv.get("gigsy.refreshToken")).toBeNull();
    expect(await auth.getAccessToken()).toBeNull();
  });

  it("adoptSession installs an externally-obtained session (test auth)", async () => {
    const kv = memoryKV();
    const auth = new AuthManager(stubApi(), kv, () => 0);

    await auth.adoptSession({
      accessToken: "at-test",
      refreshToken: "rt-test",
      user: USER,
    });

    expect(auth.isSignedIn()).toBe(true);
    expect(auth.getUser()).toEqual(USER);
    expect(await auth.getAccessToken()).toBe("at-test");
    expect(await kv.get("gigsy.refreshToken")).toBe("rt-test");
  });

  it("notifies subscribers on state changes", async () => {
    const auth = new AuthManager(stubApi(), memoryKV(), () => 0);
    const listener = vi.fn();
    auth.subscribe(listener);

    await auth.signIn("idt");
    await auth.signOut();

    expect(listener).toHaveBeenCalledTimes(2);
  });
});
