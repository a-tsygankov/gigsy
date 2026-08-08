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
    refreshSession: async () => ({ accessToken: "at-2", refreshToken: "rt-2" }),
    ...overrides,
  };
}

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
      accessToken: "at-2",
      refreshToken: "rt-2",
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

  it("bootstrap clears storage when the refresh is rejected", async () => {
    const kv = memoryKV({ "gigsy.refreshToken": "rt-dead" });
    const auth = new AuthManager(
      stubApi({ refreshSession: async () => null }),
      kv,
      () => 0,
    );

    await auth.bootstrap();

    expect(auth.isSignedIn()).toBe(false);
    expect(await kv.get("gigsy.refreshToken")).toBeNull();
  });

  it("getAccessToken refreshes only after the freshness window", async () => {
    const clock = makeClock();
    const refreshSession = vi.fn(async () => ({
      accessToken: "at-2",
      refreshToken: "rt-2",
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
