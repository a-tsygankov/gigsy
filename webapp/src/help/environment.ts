/**
 * Which install instructions to show, guessed from the user agent.
 *
 * A guess only ever preselects a choice in the picker (HelpMenu.tsx) —
 * never the only path to any instructions — so getting it wrong costs a
 * click, not a dead end.
 */
import type { HelpEnvironment } from "./types.ts";

/** Defaults to the real browser's UA; a scenario or test can still pass
 *  its own string, which is how environment.test.ts and any future
 *  detector-driven test stay independent of the machine running them. */
export function detectHelpEnvironment(
  userAgent: string = navigator.userAgent,
): HelpEnvironment {
  const ua = userAgent.toLowerCase();

  // Every iOS browser — Safari, Chrome, Edge — is a WebKit wrapper that
  // installs through the same Share-sheet flow, so the brand in the UA
  // string is noise and iOS always wins first.
  if (/iphone|ipad|ipod/.test(ua)) return "ios-safari";

  // Edge's UA still carries "Chrome/" for site-compatibility purposes
  // (and Chromium's own version number besides), so this check MUST run
  // before the Chrome check below — checking Chrome first would read
  // every desktop Edge as desktop-chrome.
  if (/edg\//.test(ua)) return "desktop-edge";

  if (/android/.test(ua) && /chrome\//.test(ua)) return "android-chrome";

  if (/chrome\//.test(ua)) return "desktop-chrome";

  // Never a guess: anything else (Firefox, Safari on macOS, an unknown
  // or empty string) gets the fallback variant instead of a wrong brand.
  return "fallback";
}
