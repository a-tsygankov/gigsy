/** @vitest-environment jsdom */
/**
 * These tests drive the REAL driver.js, not a stand-in.
 *
 * The reason is a two-time regression. Both previous rounds of this file
 * shipped green against a hand-built fake, and both times the fake was
 * wrong about the one thing that mattered: Driver.js does not hand back
 * the DriveStep object you gave it. `driver.js.mjs`'s `B(e,t,n)` returns
 * `{...i, popover: {...}}`, a fresh clone rebuilt on every highlight, and
 * the clone is what reaches `onHighlightStarted`. A fake that passes the
 * original object back makes correlating a callback to its HelpStep look
 * like it works when in production it never does — which killed every
 * click step and silenced every missing target.
 *
 * So the click-advance and missing-target paths are asserted here, on
 * observable outcomes only: what the popover says, whether the failure
 * is reported, and what is left in the DOM afterwards. The fast mocked
 * tests in TourRenderer.test.ts keep their place for the logic that does
 * not need the library; these are the ones that cannot be fooled.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { HelpTarget, dayToggle } from "../targets.ts";
import { runTour } from "./TourRenderer.ts";
import type { ClickStep, HelpScenario } from "../types.ts";

const cancels: Array<() => void> = [];

afterEach(async () => {
  for (const cancel of cancels.splice(0)) cancel();
  // Let the deferred teardown's microtask and Driver's own rAF settle
  // before the next test inspects a shared document.
  await new Promise((resolve) => setTimeout(resolve, 50));
  document.body.innerHTML = "";
  document.body.className = "";
});

function start(
  steps: HelpScenario["steps"],
  onUnavailable: (reason: string) => void = () => undefined,
): Promise<() => void> {
  return runTour(
    { id: "s", title: "Scenario", category: "settings", steps },
    { signal: new AbortController().signal, onUnavailable },
  ).then((cancel) => {
    cancels.push(cancel);
    return cancel;
  });
}

/** The description Driver.js is currently painting, which is the only
 *  thing a user can actually see change when a step advances. */
function popoverText(): string | null {
  return document.querySelector(".driver-popover-description")?.textContent ?? null;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

/** Everything Driver.js puts on the page. All of it has to be gone once
 *  a tour ends, or the user is left with a full-screen overlay they
 *  cannot dismiss — the exact failure a synchronous `destroy()` inside
 *  `onHighlightStarted` produces. */
function driverResidue(): Record<string, unknown> {
  return {
    popover: document.querySelector(".driver-popover") !== null,
    overlay: document.querySelector(".driver-overlay") !== null,
    dummy: document.getElementById("driver-dummy-element") !== null,
    bodyClass: document.body.className,
  };
}

const CLEAN = { popover: false, overlay: false, dummy: false, bodyClass: "" };

describe("runTour against the real driver.js", () => {
  it("advances a click step when the user clicks, and shows the next step", async () => {
    document.body.innerHTML = `
      <a data-testid="settings-link">Settings</a>
      <a data-testid="settings-help">Help</a>`;

    await start([
      { action: "click", target: HelpTarget.SettingsLink, description: "tap settings" },
      { action: "highlight", target: HelpTarget.SettingsHelp, description: "here is help" },
    ]);

    expect(await waitFor(() => popoverText() === "tap settings")).toBe(true);

    document
      .querySelector<HTMLElement>('[data-testid="settings-link"]')!
      .dispatchEvent(new Event("click", { bubbles: true }));

    // The assertion the fake could never make: the popover the library
    // itself rendered has moved on to the next step.
    expect(await waitFor(() => popoverText() === "here is help")).toBe(true);
  });

  it("advances a switch-kind click step from `change` on the sr-only input, not the painted span", async () => {
    document.body.innerHTML = `
      <label class="inline-flex h-11 items-center">
        <input id="day-0" type="checkbox" role="switch" class="peer sr-only" data-testid="toggle-day-0" />
        <span aria-hidden="true" class="relative h-6 w-11"></span>
      </label>
      <a data-testid="settings-help">Help</a>`;
    const input = document.querySelector<HTMLInputElement>('[data-testid="toggle-day-0"]')!;
    const span = document.querySelector<HTMLElement>('span[aria-hidden="true"]')!;

    await start([
      { action: "click", target: dayToggle(0), description: "switch it on" } satisfies ClickStep,
      { action: "highlight", target: HelpTarget.SettingsHelp, description: "now pick a time" },
    ]);

    expect(await waitFor(() => popoverText() === "switch it on")).toBe(true);
    // The library resolved the switch through `label:has(...)` to the
    // painted span — that is what it spotlighted.
    expect(document.querySelector(".driver-active-element")).toBe(span);

    // Clicking the paint is not what changes the day. Keyboard users and
    // anyone tapping the separate day-name label never send this event
    // at all, so it must not be what advances the tour.
    span.dispatchEvent(new Event("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(popoverText()).toBe("switch it on");

    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(await waitFor(() => popoverText() === "now pick a time")).toBe(true);
  });

  it("reports a target that never appears, and leaves nothing behind on the page", async () => {
    document.body.innerHTML = "";
    const onUnavailable = vi.fn();

    await start(
      [{ action: "highlight", target: HelpTarget.SettingsLink, description: "gone" }],
      onUnavailable,
    );

    // Driver.js waits out `waitForElement` and falls back to its 0x0
    // dummy node, which it reports to the hook as `undefined`. Step 0 is
    // on the long wait — it is racing the initial data load, so this
    // poll has to outlast TARGET_WAIT_BEFORE_INTERACTION_MS.
    expect(await waitFor(() => onUnavailable.mock.calls.length > 0, 10_000)).toBe(true);
    expect(onUnavailable).toHaveBeenCalledWith(expect.stringContaining("settings-link"));

    // And the tour actually goes away. A synchronous `destroy()` from
    // inside the hook does not achieve this: `J()` re-renders the
    // popover and restarts its rAF loop after the hook returns, leaving
    // a permanent overlay with `driver-active` already stripped off
    // <body>, so Driver's own pointer-events guards no longer apply.
    expect(await waitFor(() => document.querySelector(".driver-overlay") === null)).toBe(true);
    expect(driverResidue()).toEqual(CLEAN);
  }, 15_000);

  it("reports and tears down cleanly when the step a click advances into never appears", async () => {
    // The working-hours shape, and the one that needs both fixes at
    // once: the advance has to happen at all (Critical 1) before the
    // teardown that follows it can leak (Critical 2).
    document.body.innerHTML = `<a data-testid="settings-link">Settings</a>`;
    const onUnavailable = vi.fn();

    await start(
      [
        { action: "click", target: HelpTarget.SettingsLink, description: "tap settings" },
        // Never rendered by the click above, unlike the real
        // start-day-N select — so this is the stale-help case.
        { action: "highlight", target: HelpTarget.SettingsNotifications, description: "never here" },
      ],
      onUnavailable,
    );
    expect(await waitFor(() => popoverText() === "tap settings")).toBe(true);

    document
      .querySelector<HTMLElement>('[data-testid="settings-link"]')!
      .dispatchEvent(new Event("click", { bubbles: true }));

    expect(await waitFor(() => onUnavailable.mock.calls.length > 0, 10_000)).toBe(true);
    expect(onUnavailable).toHaveBeenCalledWith(
      expect.stringContaining("settings-notifications"),
    );
    expect(await waitFor(() => document.querySelector(".driver-popover") === null)).toBe(true);
    expect(driverResidue()).toEqual(CLEAN);
  }, 20_000);

  it("leaves a clean DOM when the caller cancels mid-tour", async () => {
    document.body.innerHTML = `<a data-testid="settings-link">Settings</a>`;
    const cancel = await start([
      { action: "click", target: HelpTarget.SettingsLink, description: "tap settings" },
    ]);
    expect(await waitFor(() => popoverText() === "tap settings")).toBe(true);

    cancel();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(driverResidue()).toEqual(CLEAN);
  });

  it("does not advance after cancel, even though the listener's element is still on the page", async () => {
    document.body.innerHTML = `
      <a data-testid="settings-link">Settings</a>
      <a data-testid="settings-help">Help</a>`;
    const cancel = await start([
      { action: "click", target: HelpTarget.SettingsLink, description: "tap settings" },
      { action: "highlight", target: HelpTarget.SettingsHelp, description: "here is help" },
    ]);
    expect(await waitFor(() => popoverText() === "tap settings")).toBe(true);

    cancel();
    await new Promise((resolve) => setTimeout(resolve, 50));
    document
      .querySelector<HTMLElement>('[data-testid="settings-link"]')!
      .dispatchEvent(new Event("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(driverResidue()).toEqual(CLEAN);
    expect(popoverText()).toBeNull();
  });

  it("shows an external step centred, without reporting it as a missing target", async () => {
    document.body.innerHTML = "";
    const onUnavailable = vi.fn();

    await start(
      [{ action: "external", externalType: "browser-ui", description: "use the browser menu" }],
      onUnavailable,
    );

    expect(await waitFor(() => popoverText() === "use the browser menu")).toBe(true);
    expect(onUnavailable).not.toHaveBeenCalled();
    // Still standing after the point a missing target would have ended it.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(popoverText()).toBe("use the browser menu");
    expect(onUnavailable).not.toHaveBeenCalled();
  }, 15_000);
});
