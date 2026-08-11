/**
 * "A new version is ready."
 *
 * Shown rather than acted on: reloading under someone loses whatever
 * they were typing into a gig, because form state lives in React until
 * Save. Dismissing means "not now" — a newer build asks again.
 *
 * Rendered at the app root so it reaches every screen, including login
 * and the public availability page, since a stale bundle is a stale
 * bundle wherever you happen to be standing.
 */
import { useSyncExternalStore } from "react";
import { updateStore } from "../lib/pwa-update-browser.ts";

export function UpdateBar() {
  const state = useSyncExternalStore(
    (listener) => updateStore.subscribe(listener),
    () => updateStore.getSnapshot(),
    // Server snapshot: there is no SSR here, but useSyncExternalStore
    // wants one and "idle" is the honest answer.
    () => "idle" as const,
  );

  if (state !== "ready") return null;

  return (
    <div
      role="status"
      data-testid="update-bar"
      // Above the tab bar (z-30) and the FAB (z-40) both: it is the one
      // thing on screen that should not be sat behind something else.
      className="fixed inset-x-0 bottom-0 z-50 border-t border-slate-200 bg-white/95
                 px-4 py-3 backdrop-blur pb-[calc(0.75rem+env(safe-area-inset-bottom))]"
    >
      <div className="mx-auto flex max-w-lg items-center gap-3">
        <p className="min-w-0 flex-1 text-sm text-slate-700">
          A new version is ready.
        </p>
        <button
          type="button"
          data-testid="update-bar-reload"
          onClick={() => updateStore.apply()}
          className="shrink-0 rounded-xl bg-emerald-600 px-3 py-2 text-sm font-semibold
                     text-on-accent transition-colors hover:bg-accent-hover
                     focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
        >
          Reload
        </button>
        <button
          type="button"
          aria-label="Dismiss update"
          data-testid="update-bar-dismiss"
          onClick={() => updateStore.dismiss()}
          className="shrink-0 rounded-xl px-2 py-2 text-sm text-slate-500
                     transition-colors hover:text-slate-700 focus:outline-none
                     focus-visible:ring-2 focus-visible:ring-emerald-500"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
