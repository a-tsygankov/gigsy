/**
 * Two things share the theme's boot rules and must not drift:
 * public/theme-boot.js, the pre-paint script index.html loads, and
 * lib/theme.ts, which main.tsx applies again as the in-bundle fallback.
 * theme.test.ts pins the module; this file runs the SCRIPT — the
 * actual file that ships — against the same cases, and then the
 * module's boot and follower functions.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { bootTheme, followSystemTheme, THEME_COLORS } from "./theme.ts";

const SCRIPT = readFileSync(
  fileURLToPath(new URL("../../public/theme-boot.js", import.meta.url)),
  "utf8",
);

/** A page as the script sees it: storage, the media query, <html> and
 *  the theme-color meta. Returned so a test can read what was set. */
function page(options: { stored?: string | null; prefersDark?: boolean; storageThrows?: boolean }) {
  const html = new Map<string, string>();
  const meta = new Map<string, string>([["content", "#f8fafc"]]);
  const localStorage = {
    getItem: () => {
      if (options.storageThrows) throw new Error("SecurityError");
      return options.stored ?? null;
    },
  };
  const context = {
    localStorage,
    window: { matchMedia: () => ({ matches: options.prefersDark ?? false }) },
    document: {
      documentElement: { setAttribute: (k: string, v: string) => html.set(k, v) },
      querySelector: (selector: string) =>
        selector === 'meta[name="theme-color"]'
          ? { setAttribute: (k: string, v: string) => meta.set(k, v) }
          : null,
    },
  };
  return { context, html, meta };
}

function run(options: Parameters<typeof page>[0]) {
  const p = page(options);
  vm.runInNewContext(SCRIPT, p.context);
  return { theme: p.html.get("data-theme"), chrome: p.meta.get("content") };
}

describe("public/theme-boot.js — the file that ships", () => {
  it("is a plain script with no module syntax, so a classic <script src> can run it", () => {
    expect(SCRIPT).not.toMatch(/\bimport\b|\bexport\b/);
  });

  it("applies a stored dark theme and the dark chrome colour", () => {
    expect(run({ stored: "dark" })).toEqual({ theme: "dark", chrome: THEME_COLORS.dark });
  });

  it("applies a stored light theme even on a dark device", () => {
    expect(run({ stored: "light", prefersDark: true })).toEqual({
      theme: "light",
      chrome: THEME_COLORS.light,
    });
  });

  it("follows the device when the choice is system, or nothing is stored", () => {
    expect(run({ stored: "system", prefersDark: true }).theme).toBe("dark");
    expect(run({ stored: null, prefersDark: true }).theme).toBe("dark");
    expect(run({ stored: null, prefersDark: false }).theme).toBe("light");
  });

  it("treats an unrecognised stored value as system", () => {
    expect(run({ stored: "blue", prefersDark: true }).theme).toBe("dark");
  });

  it("falls back to light, without throwing, when storage is off limits", () => {
    expect(run({ storageThrows: true }).theme).toBe("light");
  });
});

describe("bootTheme — the in-bundle fallback", () => {
  function fakes(stored: string | null, prefersDark: boolean) {
    const html = new Map<string, string>();
    const meta = new Map<string, string>();
    const listeners: Array<() => void> = [];
    const win = {
      localStorage: { getItem: () => stored },
      matchMedia: () => ({
        matches: prefersDark,
        addEventListener: (_: string, fn: () => void) => {
          listeners.push(fn);
        },
        removeEventListener: (_: string, fn: () => void) => {
          const i = listeners.indexOf(fn);
          if (i >= 0) listeners.splice(i, 1);
        },
      }),
    };
    const doc = {
      documentElement: { setAttribute: (k: string, v: string) => html.set(k, v) },
      querySelector: () => ({ setAttribute: (k: string, v: string) => meta.set(k, v) }),
    };
    return { win, doc, html, meta, listeners, setStored: (v: string) => (stored = v), setDark: (d: boolean) => (prefersDark = d) };
  }

  it("applies the stored theme and reports what it resolved to", () => {
    const f = fakes("dark", false);
    expect(bootTheme(f.win, f.doc)).toBe("dark");
    expect(f.html.get("data-theme")).toBe("dark");
    expect(f.meta.get("content")).toBe(THEME_COLORS.dark);
  });

  it("agrees with the boot script on every case the script is tested for", () => {
    const cases: Array<[string | null, boolean]> = [
      ["dark", false],
      ["light", true],
      ["system", true],
      [null, true],
      [null, false],
      ["blue", true],
    ];
    for (const [stored, prefersDark] of cases) {
      const f = fakes(stored, prefersDark);
      expect(bootTheme(f.win, f.doc)).toBe(run({ stored, prefersDark }).theme);
    }
  });
});

describe("followSystemTheme — the app-wide OS follower", () => {
  it("re-themes on an OS change only while the choice is system", () => {
    let stored: string | null = "system";
    let dark = false;
    const html = new Map<string, string>();
    const listeners: Array<() => void> = [];
    const win = {
      localStorage: { getItem: () => stored },
      matchMedia: () => ({
        get matches() {
          return dark;
        },
        addEventListener: (_: string, fn: () => void) => {
          listeners.push(fn);
        },
        removeEventListener: vi.fn(),
      }),
    };
    const doc = {
      documentElement: { setAttribute: (k: string, v: string) => html.set(k, v) },
      querySelector: () => null,
    };
    followSystemTheme(win, doc);
    expect(listeners).toHaveLength(1);

    dark = true;
    listeners[0]!();
    expect(html.get("data-theme")).toBe("dark");

    // An explicit choice made later must not be overridden by the OS —
    // the follower re-reads the choice on every change rather than
    // capturing it at install.
    stored = "light";
    dark = false;
    listeners[0]!();
    expect(html.get("data-theme")).toBe("dark");
  });

  it("stops listening when torn down", () => {
    const removeEventListener = vi.fn();
    const win = {
      localStorage: { getItem: () => "system" },
      matchMedia: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener }),
    };
    const stop = followSystemTheme(win, {
      documentElement: { setAttribute: vi.fn() },
      querySelector: () => null,
    });
    stop();
    expect(removeEventListener).toHaveBeenCalledWith("change", expect.any(Function));
  });
});

describe("public/theme-boot.js — a fresh theme-color tag when the page allows it", () => {
  it("replaces the tag rather than editing it, and still edits where it cannot", () => {
    const created: Map<string, string>[] = [];
    let replacedWith: unknown = null;
    const html = new Map<string, string>();
    const context = {
      localStorage: { getItem: () => "dark" },
      window: { matchMedia: () => ({ matches: false }) },
      document: {
        documentElement: { setAttribute: (k: string, v: string) => html.set(k, v) },
        querySelector: () => ({
          setAttribute: () => {
            throw new Error("the old tag must not be edited when it can be replaced");
          },
          replaceWith: (node: unknown) => {
            replacedWith = node;
          },
        }),
        createElement: () => {
          const attrs = new Map<string, string>();
          created.push(attrs);
          return { setAttribute: (k: string, v: string) => attrs.set(k, v) };
        },
      },
    };
    vm.runInNewContext(SCRIPT, context);
    expect(html.get("data-theme")).toBe("dark");
    expect(created).toHaveLength(1);
    expect(created[0]!.get("name")).toBe("theme-color");
    expect(created[0]!.get("content")).toBe(THEME_COLORS.dark);
    expect(replacedWith).not.toBeNull();
    // The fakes in `page()` above have no replaceWith, and the cases
    // there still pass: that is the in-place path.
    expect(run({ stored: "dark" }).chrome).toBe(THEME_COLORS.dark);
  });
});
