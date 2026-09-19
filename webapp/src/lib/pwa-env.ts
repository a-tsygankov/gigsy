/**
 * Where the app is running, as far as a few features need to know.
 *
 * Two questions, asked by two features that behave differently on the
 * installed iOS app: push (lib/push.ts — the APIs do not exist until
 * installed) and invoice printing (lib/invoice-export.ts —
 * `window.print()` is a silent no-op once installed). Both used to
 * spell the same two checks inline; one place, so a third feature
 * cannot get one of them subtly wrong.
 *
 * Typed against the two calls made rather than `Window`/`Navigator`,
 * so a test can hand in an iPhone without a browser.
 */
export interface PwaEnvSource {
  userAgent: string;
  /** `navigator.standalone` — Safari's own flag, older than the
   *  display-mode media query and still the one iOS sets reliably. */
  standalone?: boolean;
  matchMedia(query: string): { matches: boolean };
}

export function isIos(env: Pick<PwaEnvSource, "userAgent">): boolean {
  return /iphone|ipad|ipod/i.test(env.userAgent);
}

/** Launched from the home screen rather than in a browser tab. */
export function isStandalone(env: PwaEnvSource): boolean {
  return env.matchMedia("(display-mode: standalone)").matches || env.standalone === true;
}

export function browserEnv(win: Window = window): PwaEnvSource {
  const nav = win.navigator as Navigator & { standalone?: boolean };
  return {
    userAgent: nav.userAgent,
    ...(nav.standalone !== undefined ? { standalone: nav.standalone } : {}),
    matchMedia: (query) => win.matchMedia(query),
  };
}
