/**
 * The browser half of self-update: registration, update checks, and
 * the events that drive the store.
 *
 * Deliberately logic-free — every decision lives in `pwa-update.ts`,
 * which is testable without a DOM. An `if` added here probably belongs
 * there instead.
 *
 * Uses the Service Worker API directly rather than vite-plugin-pwa's
 * `virtual:pwa-register`, which drags in `workbox-window` for what
 * amounts to the twenty lines below. This project keeps its dependency
 * list short on purpose, and doing it by hand also makes the
 * first-install case explicit — see the controller check.
 */
import { createUpdateStore, type UpdateStore } from "./pwa-update.ts";
import { appLog } from "./logger.ts";

/** The installed-but-waiting worker, kept so `apply` can reach it. */
let waiting: ServiceWorker | null = null;
let registration: ServiceWorkerRegistration | null = null;

export const updateStore: UpdateStore = createUpdateStore({
  skipWaiting: () => waiting?.postMessage({ type: "SKIP_WAITING" }),
  reload: () => window.location.reload(),
});

/**
 * A worker that is installed while another one already controls this
 * page is an update. The same state with no controller is the very
 * first install, which is not news and must not raise the bar.
 */
function offerIfUpdate(worker: ServiceWorker | null): void {
  if (worker === null || navigator.serviceWorker.controller === null) return;
  waiting = worker;
  updateStore.markReady();
}

/**
 * Start listening. Safe to call once at boot, and a no-op where
 * service workers are unavailable (private windows, older iOS) — the
 * app simply never offers an update there rather than failing.
 */
export function startUpdateWatch(): void {
  if (!("serviceWorker" in navigator)) return;

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    updateStore.onControllerChange();
  });

  void navigator.serviceWorker
    .register("/sw.js", { scope: "/" })
    .then((reg) => {
      registration = reg;

      // Installed during a previous visit and still waiting.
      offerIfUpdate(reg.waiting);

      reg.addEventListener("updatefound", () => {
        const installing = reg.installing;
        if (installing === null) return;
        installing.addEventListener("statechange", () => {
          if (installing.state === "installed") offerIfUpdate(installing);
        });
      });
    })
    .catch((error: unknown) => {
      // Not fatal: the app runs, it just cannot update itself or work
      // offline. Worth a line in the hidden console rather than silence.
      appLog.warn("service worker registration failed", { error: String(error) });
    });

  // The browser only looks for a new worker on navigation or roughly
  // daily, which never happens in a PWA someone leaves open. Coming
  // back to the app is the natural moment to ask.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void registration?.update();
  });
}
