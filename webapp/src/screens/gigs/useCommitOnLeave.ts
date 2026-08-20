/**
 * Write a typed-but-uncommitted value when the screen or the page goes
 * away.
 *
 * Any field that commits on blur has the same hole in it, and it is not
 * a small one: `focusout` is not guaranteed when a focused input is
 * unmounted by a route change, and on iOS Safari tapping a link does not
 * move focus at all. So "type a break, tap the tab bar" discards the
 * value — while the screen still says it saves as you go.
 *
 * Two exits, because they are different events. `pagehide` covers
 * leaving the app: closing the tab, backgrounding it, a swipe-back into
 * the back-forward cache. It is deliberately not `beforeunload`, which
 * iOS Safari does not fire. Unmount covers leaving the screen while the
 * app stays open, which is the common one.
 *
 * `pending` is read through a ref rather than closed over, so the
 * listener is attached once instead of on every keystroke — and so the
 * unmount path sees the LAST value, not the value at mount.
 *
 * Placed beside its caller like screens/settings/useSettings.ts.
 */
import { useEffect, useRef } from "react";

export function useCommitOnLeave<T>(
  /** The uncommitted write, or null when there is nothing outstanding.
   *  Recomputed on every render; only ever called at the two exits. */
  pending: () => T | null,
  /** Must not depend on the calling component still being mounted —
   *  one of the two exits IS its unmount. */
  commit: (value: T) => void,
): void {
  const latest = useRef({ pending, commit });
  latest.current = { pending, commit };

  useEffect(() => {
    const flush = (): void => {
      const value = latest.current.pending();
      if (value !== null) latest.current.commit(value);
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, []);
}
