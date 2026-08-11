/**
 * The update state machine.
 *
 * Pure and effect-injected because this repo has no React Testing
 * Library and no jsdom — the parts worth being sure about have to be
 * testable without a DOM, so the browser glue holds no logic at all.
 */
import { describe, it, expect, vi } from "vitest";
import { createUpdateStore } from "./pwa-update.ts";

function make() {
  const skipWaiting = vi.fn();
  const reload = vi.fn();
  return { store: createUpdateStore({ skipWaiting, reload }), skipWaiting, reload };
}

describe("createUpdateStore", () => {
  it("starts idle, so nothing is shown on an ordinary load", () => {
    expect(make().store.getSnapshot()).toBe("idle");
  });

  it("becomes ready when a new worker is waiting", () => {
    const { store } = make();
    store.markReady();

    expect(store.getSnapshot()).toBe("ready");
  });

  it("hides on dismiss without applying the update", () => {
    const { store, skipWaiting, reload } = make();
    store.markReady();

    store.dismiss();

    expect(store.getSnapshot()).toBe("dismissed");
    expect(skipWaiting).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("prompts again when a NEWER update arrives after a dismiss", () => {
    // Dismissing means "not now", not "never tell me again" — otherwise
    // one dismissal strands the tab on that version for its whole life.
    const { store } = make();
    store.markReady();
    store.dismiss();

    store.markReady();

    expect(store.getSnapshot()).toBe("ready");
  });

  it("asks the waiting worker to take over when applied", () => {
    const { store, skipWaiting } = make();
    store.markReady();

    store.apply();

    expect(skipWaiting).toHaveBeenCalledTimes(1);
  });

  it("does not ask twice on a double tap", () => {
    // The button stays on screen until the reload lands, so it can be
    // pressed again in the gap.
    const { store, skipWaiting } = make();
    store.markReady();

    store.apply();
    store.apply();

    expect(skipWaiting).toHaveBeenCalledTimes(1);
  });

  it("does nothing when applied with no update waiting", () => {
    const { store, skipWaiting, reload } = make();

    store.apply();

    expect(skipWaiting).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads when the worker we asked for takes over", () => {
    const { store, reload } = make();
    store.markReady();
    store.apply();

    store.onControllerChange();

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does NOT reload on a controller change this tab did not ask for", () => {
    // Two things fire this: the very first service worker install, and
    // another tab applying the update. Reloading on either would throw
    // away what someone is typing in a window they never touched.
    const { store, reload } = make();
    store.markReady();

    store.onControllerChange();

    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads once even if the controller change fires twice", () => {
    const { store, reload } = make();
    store.markReady();
    store.apply();

    store.onControllerChange();
    store.onControllerChange();

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("notifies subscribers on every state change", () => {
    const { store } = make();
    const seen = vi.fn();
    store.subscribe(seen);

    store.markReady();
    store.dismiss();

    expect(seen).toHaveBeenCalledTimes(2);
  });

  it("stops notifying after unsubscribe", () => {
    const { store } = make();
    const seen = vi.fn();
    const off = store.subscribe(seen);

    off();
    store.markReady();

    expect(seen).not.toHaveBeenCalled();
  });

  it("does not notify when the state did not actually change", () => {
    // useSyncExternalStore re-renders on every notification, so a
    // repeated markReady from a second update check should be quiet.
    const { store } = make();
    const seen = vi.fn();
    store.markReady();
    store.subscribe(seen);

    store.markReady();

    expect(seen).not.toHaveBeenCalled();
  });
});
