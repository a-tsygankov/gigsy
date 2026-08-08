/**
 * Generic persisted settings store: typed defaults, pluggable
 * storage (localStorage in the app, in-memory in tests), subscribe
 * for reactive consumers. The app instance lives at the bottom.
 */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface SettingsStore<T extends Record<string, unknown>> {
  get(): T;
  set<K extends keyof T>(key: K, value: T[K]): void;
  subscribe(listener: (settings: T) => void): () => void;
  reset(): void;
}

export interface SettingsStoreOptions<T extends Record<string, unknown>> {
  /** Storage key the whole settings object is persisted under. */
  key: string;
  defaults: T;
  storage?: KeyValueStorage;
}

class MemoryStorage implements KeyValueStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

function defaultStorage(): KeyValueStorage {
  // SSR/tests/blocked-storage safety: fall back to a memory store.
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    /* storage access can throw in privacy modes */
  }
  return new MemoryStorage();
}

export function createSettingsStore<T extends Record<string, unknown>>(
  options: SettingsStoreOptions<T>,
): SettingsStore<T> {
  const storage = options.storage ?? defaultStorage();
  const listeners = new Set<(settings: T) => void>();

  function load(): T {
    const raw = storage.getItem(options.key);
    if (raw === null) return { ...options.defaults };
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) return { ...options.defaults };
      // Defaults define the shape — persisted junk keys are dropped,
      // missing keys fall back to their default.
      const merged = { ...options.defaults };
      for (const key of Object.keys(options.defaults) as (keyof T)[]) {
        if (key in parsed) {
          merged[key] = (parsed as Record<keyof T, T[keyof T]>)[key];
        }
      }
      return merged;
    } catch {
      return { ...options.defaults };
    }
  }

  let current = load();

  function persistAndNotify(): void {
    storage.setItem(options.key, JSON.stringify(current));
    for (const listener of listeners) listener({ ...current });
  }

  return {
    get(): T {
      return { ...current };
    },
    set(key, value): void {
      current = { ...current, [key]: value };
      persistAndNotify();
    },
    subscribe(listener): () => void {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    reset(): void {
      current = { ...options.defaults };
      persistAndNotify();
    },
  };
}

/** Gigsy app settings — displayed (and grown over time) in the
 * hidden console's Settings section. */
export type AppSettings = {
  theme: "system" | "light" | "dark";
  logLevel: "info" | "warn" | "error";
  workerLogLimit: number;
};

export const settings = createSettingsStore<AppSettings>({
  key: "gigsy.settings",
  defaults: { theme: "system", logLevel: "info", workerLogLimit: 100 },
});
