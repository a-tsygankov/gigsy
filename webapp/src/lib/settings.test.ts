import { describe, it, expect, vi } from "vitest";
import { createSettingsStore, type KeyValueStorage } from "./settings.ts";

function memoryStorage(initial: Record<string, string> = {}): KeyValueStorage {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  };
}

const DEFAULTS = { theme: "system", logLevel: "info", workerLogLimit: 100 };

describe("createSettingsStore", () => {
  it("returns defaults when storage is empty", () => {
    const store = createSettingsStore({
      key: "t",
      defaults: DEFAULTS,
      storage: memoryStorage(),
    });
    expect(store.get()).toEqual(DEFAULTS);
  });

  it("persists a set value and reads it back in a fresh store", () => {
    const storage = memoryStorage();
    const a = createSettingsStore({ key: "t", defaults: DEFAULTS, storage });
    a.set("theme", "dark");

    const b = createSettingsStore({ key: "t", defaults: DEFAULTS, storage });
    expect(b.get().theme).toBe("dark");
    expect(b.get().logLevel).toBe("info"); // untouched keys keep defaults
  });

  it("falls back to defaults on corrupted storage", () => {
    const store = createSettingsStore({
      key: "t",
      defaults: DEFAULTS,
      storage: memoryStorage({ t: "{not json" }),
    });
    expect(store.get()).toEqual(DEFAULTS);
  });

  it("drops persisted keys that are not in the defaults shape", () => {
    const store = createSettingsStore({
      key: "t",
      defaults: DEFAULTS,
      storage: memoryStorage({ t: JSON.stringify({ theme: "dark", junk: 1 }) }),
    });
    expect(store.get()).toEqual({ ...DEFAULTS, theme: "dark" });
  });

  it("notifies subscribers on set and honours unsubscribe", () => {
    const store = createSettingsStore({
      key: "t",
      defaults: DEFAULTS,
      storage: memoryStorage(),
    });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.set("logLevel", "warn");
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ logLevel: "warn" }));

    unsubscribe();
    store.set("logLevel", "error");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
