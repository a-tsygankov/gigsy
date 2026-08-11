/**
 * Whether a newer build is waiting, and what to do about it.
 *
 * The app is a PWA people leave open. Before this, a deploy reached
 * them only when every tab had closed: the browser looks for a new
 * `sw.js` on navigation or roughly daily, and even once it finds one
 * the running page keeps its old JS bundle until a reload.
 *
 * Effects are injected and there is no DOM here, because the repo has
 * no React Testing Library and no jsdom — logic that cannot be tested
 * without a browser is logic nobody checks. The glue that imports
 * `virtual:pwa-register` holds none.
 */

/** `dismissed` is "not now", and a newer build clears it. */
export type UpdateState = "idle" | "ready" | "dismissed";

export interface UpdateStoreDeps {
  /** Tell the waiting worker to activate. */
  skipWaiting: () => void;
  reload: () => void;
}

export interface UpdateStore {
  subscribe(listener: () => void): () => void;
  /** A string, so useSyncExternalStore compares by value and does not
   *  re-render on every notification. */
  getSnapshot(): UpdateState;
  /** A new worker is installed and waiting. */
  markReady(): void;
  dismiss(): void;
  apply(): void;
  /** The active worker changed. */
  onControllerChange(): void;
}

export function createUpdateStore(deps: UpdateStoreDeps): UpdateStore {
  let state: UpdateState = "idle";
  let applying = false;
  let reloaded = false;
  const listeners = new Set<() => void>();

  function set(next: UpdateState): void {
    if (next === state) return;
    state = next;
    for (const listener of listeners) listener();
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    getSnapshot: () => state,
    markReady: () => set("ready"),
    dismiss: () => set("dismissed"),

    apply() {
      // Nothing waiting, or already on its way: the button stays on
      // screen until the reload lands, so it can be pressed twice.
      if (state !== "ready" || applying) return;
      applying = true;
      deps.skipWaiting();
    },

    onControllerChange() {
      // Only reload the tab that asked. This fires on the very first
      // worker install too, and again in every open tab when any one of
      // them applies — reloading on either would throw away what
      // someone is typing in a window they never touched.
      if (!applying || reloaded) return;
      reloaded = true;
      deps.reload();
    },
  };
}
