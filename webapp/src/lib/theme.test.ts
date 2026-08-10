import { describe, it, expect } from "vitest";
import {
  THEME_COLORS,
  THEME_STORAGE_KEY,
  applyTheme,
  readStoredTheme,
  resolveTheme,
  storeTheme,
} from "./theme.ts";

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

/** Storage that throws, as private mode and disabled storage both do. */
const hostileStorage = {
  getItem: () => {
    throw new Error("denied");
  },
  setItem: () => {
    throw new Error("denied");
  },
};

describe("resolveTheme", () => {
  it("follows the OS only in system mode", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });

  it("lets an explicit choice beat the OS", () => {
    // Otherwise choosing light on a dark phone would appear to do nothing.
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});

describe("readStoredTheme", () => {
  it("defaults to system when nothing is stored", () => {
    expect(readStoredTheme(fakeStorage())).toBe("system");
  });

  it("returns a stored choice", () => {
    expect(readStoredTheme(fakeStorage({ [THEME_STORAGE_KEY]: "dark" }))).toBe("dark");
  });

  it("treats an unrecognised value as system rather than throwing", () => {
    // This runs before first paint; throwing there is a blank screen.
    expect(readStoredTheme(fakeStorage({ [THEME_STORAGE_KEY]: "neon" }))).toBe("system");
  });

  it("survives storage that throws on access", () => {
    expect(readStoredTheme(hostileStorage)).toBe("system");
  });
});

describe("storeTheme", () => {
  it("persists the choice", () => {
    const storage = fakeStorage();
    storeTheme(storage, "dark");
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  });

  it("does not throw when storage refuses", () => {
    expect(() => storeTheme(hostileStorage, "dark")).not.toThrow();
  });
});

describe("applyTheme", () => {
  function fakeDoc(withMeta: boolean) {
    const root: Record<string, string> = {};
    const meta: Record<string, string> = {};
    return {
      root,
      meta,
      doc: {
        documentElement: {
          setAttribute: (n: string, v: string) => void (root[n] = v),
        },
        querySelector: (_s: string) =>
          withMeta ? { setAttribute: (n: string, v: string) => void (meta[n] = v) } : null,
      },
    };
  }

  it("writes the resolved theme onto the root element", () => {
    const { root, doc } = fakeDoc(false);

    applyTheme(doc, "dark");
    expect(root["data-theme"]).toBe("dark");

    applyTheme(doc, "light");
    expect(root["data-theme"]).toBe("light");
  });

  it("keeps the browser chrome colour in step", () => {
    // Declared in index.html and the manifest both; a mismatch flashes
    // the wrong colour during launch.
    const { meta, doc } = fakeDoc(true);

    applyTheme(doc, "dark");
    expect(meta.content).toBe(THEME_COLORS.dark);

    applyTheme(doc, "light");
    expect(meta.content).toBe(THEME_COLORS.light);
  });

  it("does not require the meta tag to exist", () => {
    const { doc } = fakeDoc(false);
    expect(() => applyTheme(doc, "dark")).not.toThrow();
  });
});
