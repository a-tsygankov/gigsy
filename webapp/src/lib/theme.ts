/**
 * Theme selection (Phase 11, Task 4).
 *
 * Three choices, not a toggle: a phone that dims itself at night should
 * take the app with it, and forcing a decision on someone who has
 * already told their OS is rude.
 *
 * This is the one setting that does NOT sync. Everything else belongs
 * to the person and rides in settings_json; a theme belongs to the
 * device and its surroundings — dark on a phone at a night shift, light
 * on a laptop in daylight. Syncing it would work against the user.
 */

export type ThemeChoice = "system" | "light" | "dark";
/** What "system" resolves to. CSS and the meta tag only ever see this. */
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "gigsy:theme";

/** The browser chrome colour per theme, matching --bg-app. Declared in
 *  index.html and the PWA manifest both, and the design system warns
 *  that a mismatch flashes the wrong colour during launch — so the tag
 *  is updated at runtime to follow whichever theme actually applies. */
export const THEME_COLORS: Record<ResolvedTheme, string> = {
  light: "#f8fafc",
  dark: "#0f172a",
};

function isChoice(value: unknown): value is ThemeChoice {
  return value === "system" || value === "light" || value === "dark";
}

/** The stored choice, defaulting to system. Anything unrecognised — a
 *  hand-edited value, or one written by a future version — is treated
 *  as system rather than throwing on a code path that runs before paint. */
export function readStoredTheme(storage: Pick<Storage, "getItem">): ThemeChoice {
  try {
    const raw = storage.getItem(THEME_STORAGE_KEY);
    return isChoice(raw) ? raw : "system";
  } catch {
    // Private mode and disabled storage both throw on access.
    return "system";
  }
}

export function storeTheme(
  storage: Pick<Storage, "setItem">,
  choice: ThemeChoice,
): void {
  try {
    storage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // A theme that fails to persist is a small loss; crashing is not.
  }
}

/** `prefersDark` is only consulted for "system" — an explicit choice
 *  must win over the OS, or choosing light on a dark phone does nothing. */
export function resolveTheme(choice: ThemeChoice, prefersDark: boolean): ResolvedTheme {
  if (choice === "light") return "light";
  if (choice === "dark") return "dark";
  return prefersDark ? "dark" : "light";
}

/**
 * Write the resolved theme where CSS and the browser can see it.
 *
 * Typed against the two calls it makes rather than `Document`, so the
 * rules are testable without pulling a DOM implementation into a
 * dependency list this project keeps deliberately short.
 *
 * Always an explicit light|dark, never "system": keeping the resolution
 * in one place means the stylesheet needs no prefers-color-scheme branch
 * that could disagree with what was decided here.
 */
export interface ThemeTarget {
  documentElement: { setAttribute(name: string, value: string): void };
  querySelector(
    selector: string,
  ): { setAttribute(name: string, value: string): void } | null;
}

export function applyTheme(doc: ThemeTarget, resolved: ResolvedTheme): void {
  doc.documentElement.setAttribute("data-theme", resolved);
  const meta = doc.querySelector('meta[name="theme-color"]');
  if (meta !== null) meta.setAttribute("content", THEME_COLORS[resolved]);
}
