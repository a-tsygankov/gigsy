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
import { HelpTarget, dayStart, dayToggle } from "../targets.ts";
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
      <a data-testid="settings-notifications">Notifications</a>`;

    await start([
      { action: "click", target: HelpTarget.SettingsLink, description: "tap settings" },
      { action: "highlight", target: HelpTarget.SettingsNotifications, description: "here is help" },
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
      <a data-testid="settings-notifications">Notifications</a>`;
    const input = document.querySelector<HTMLInputElement>('[data-testid="toggle-day-0"]')!;
    const span = document.querySelector<HTMLElement>('span[aria-hidden="true"]')!;

    await start([
      { action: "click", target: dayToggle(0), description: "switch it on" } satisfies ClickStep,
      { action: "highlight", target: HelpTarget.SettingsNotifications, description: "now pick a time" },
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

  describe("exactly one element is ever spotlighted", () => {
    /** The real NotificationsSection shape: push-unavailable is a <p>
     *  INSIDE the settings-notifications <section>, which is how this
     *  was first seen in a browser. */
    const nested = `
      <section data-testid="settings-notifications">
        <h2>Notifications</h2>
        <p data-testid="push-unavailable">Blocked in browser settings.</p>
      </section>`;
    /** Same two targets, no ancestry between them — nesting is not what
     *  causes this, and pinning that down keeps the next person from
     *  "fixing" the wrong thing. */
    const siblings = `
      <section data-testid="settings-notifications"><h2>Notifications</h2></section>
      <p data-testid="push-unavailable">Blocked in browser settings.</p>`;

    function spotlighted(): string[] {
      return [...document.querySelectorAll(".driver-active-element")].map(
        (el) => el.getAttribute("data-testid") ?? el.tagName,
      );
    }

    /** `delayBeforeNext` is the whole point. Driver.js only records
     *  `__activeElement` once a highlight has settled — `elapsed >=
     *  duration`, 400ms by default — and it is that recorded element,
     *  not the outgoing one, that it later strips the class from.
     *  Advance sooner and it strips the class from the element it is
     *  about to add it to, stranding the previous step's spotlight. A
     *  click step advances on the user's own tap, so this window is the
     *  normal case here, not a corner. */
    async function advanceAfter(dom: string, delayBeforeNext: number): Promise<void> {
      document.body.innerHTML = dom;
      await start([
        { action: "highlight", target: HelpTarget.SettingsNotifications, description: "step0" },
        { action: "highlight", target: HelpTarget.PushUnavailable, description: "step1" },
      ]);
      expect(await waitFor(() => popoverText() === "step0")).toBe(true);
      expect(spotlighted()).toEqual(["settings-notifications"]);

      await new Promise((resolve) => setTimeout(resolve, delayBeforeNext));
      document
        .querySelector<HTMLElement>(".driver-popover-next-btn")!
        .dispatchEvent(new Event("click", { bubbles: true }));

      expect(await waitFor(() => popoverText() === "step1")).toBe(true);
      // Let the transition settle, so this cannot pass by catching an
      // intermediate frame.
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(spotlighted()).toEqual(["push-unavailable"]);
    }

    it("when the next step is nested inside the current one and Next comes fast", async () => {
      await advanceAfter(nested, 100);
    }, 15_000);

    it("when the two targets are siblings and Next comes fast", async () => {
      await advanceAfter(siblings, 100);
    }, 15_000);

    it("when Next comes after the transition has settled", async () => {
      await advanceAfter(nested, 600);
    }, 15_000);

    it("leaves no stale aria pointing assistive tech at the old element", async () => {
      document.body.innerHTML = nested;
      await start([
        { action: "highlight", target: HelpTarget.SettingsNotifications, description: "step0" },
        { action: "highlight", target: HelpTarget.PushUnavailable, description: "step1" },
      ]);
      expect(await waitFor(() => popoverText() === "step0")).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 100));
      document
        .querySelector<HTMLElement>(".driver-popover-next-btn")!
        .dispatchEvent(new Event("click", { bubbles: true }));
      expect(await waitFor(() => popoverText() === "step1")).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 600));

      // Driver.js sets these alongside the class and clears them from
      // the same node it clears the class from, so they go stale
      // together (§7.5: the tour must not misreport the page).
      const section = document.querySelector('[data-testid="settings-notifications"]')!;
      expect(section.getAttribute("aria-haspopup")).toBeNull();
      expect(section.getAttribute("aria-expanded")).toBeNull();
      expect(section.getAttribute("aria-controls")).toBeNull();
    }, 15_000);
  });

  describe("a target that vanishes after its step is entered", () => {
    /** AvailabilitySection's real shape: the start/end selects exist
     *  only while the day is switched on. */
    function week(sundayOn: boolean): string {
      return `
        <div data-testid="avail-working-week">
          <label class="inline-flex">
            <input id="day-0" type="checkbox" role="switch" class="peer sr-only"
                   data-testid="toggle-day-0" ${sundayOn ? "checked" : ""} />
            <span aria-hidden="true" class="relative h-6 w-11"></span>
          </label>
          ${sundayOn ? `<select data-testid="start-day-0"><option value="540">09:00</option></select>` : ""}
        </div>`;
    }

    const workingHours: HelpScenario["steps"] = [
      { action: "click", target: dayToggle(0), description: "tap the switch" },
      { action: "select", target: dayStart(0), value: "540", description: "set the start time" },
    ];

    it("reports and tears down when the click that advances also removes the next target", async () => {
      // The reported hang, reduced. Started from a day that is ALREADY
      // ON, the tap switches it off and the row collapses — so the
      // select this step wants never comes back.
      //
      // Driver.js cannot see this on its own. Our click listener sits on
      // the control, so it advances before React's delegated handler has
      // even run: at the instant Driver.js resolves `start-day-0` it is
      // still on the page, `waitForElement` never engages, and the hook
      // is handed a real, connected element. Nothing is wrong as far as
      // Driver.js is concerned, and without a watchdog nothing is ever
      // reported.
      document.body.innerHTML = week(true);
      const onUnavailable = vi.fn();
      await start(workingHours, onUnavailable);
      expect(await waitFor(() => popoverText() === "tap the switch")).toBe(true);

      const input = document.querySelector<HTMLInputElement>('[data-testid="toggle-day-0"]')!;
      input.checked = false;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      // React collapses the row on the next render, after the tour has
      // already advanced.
      document.querySelector('[data-testid="start-day-0"]')!.remove();

      expect(await waitFor(() => onUnavailable.mock.calls.length > 0)).toBe(true);
      expect(onUnavailable).toHaveBeenCalledWith(expect.stringContaining("start-day-0"));
      // §10: a dead end the user can back out of, not one they have to
      // reload out of.
      expect(await waitFor(() => document.querySelector(".driver-overlay") === null)).toBe(true);
      expect(driverResidue()).toEqual(CLEAN);
    }, 15_000);

    it("does not report when the click creates the next target instead of removing it", async () => {
      // The negative control, and the one that matters most: this is the
      // scenario working correctly. A watchdog that cannot tell "gone"
      // from "arriving late" would call a healthy app broken.
      document.body.innerHTML = week(false);
      const onUnavailable = vi.fn();
      await start(workingHours, onUnavailable);
      expect(await waitFor(() => popoverText() === "tap the switch")).toBe(true);

      const input = document.querySelector<HTMLInputElement>('[data-testid="toggle-day-0"]')!;
      input.checked = true;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      document
        .querySelector('[data-testid="avail-working-week"]')!
        .insertAdjacentHTML(
          "beforeend",
          `<select data-testid="start-day-0"><option value="540">09:00</option></select>`,
        );

      expect(await waitFor(() => popoverText() === "set the start time")).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 800));
      expect(onUnavailable).not.toHaveBeenCalled();
      expect(popoverText()).toBe("set the start time");
    }, 15_000);

    it("does not report a target that is removed and comes straight back", async () => {
      // A React re-render can unmount and remount across two flushes,
      // leaving the selector genuinely unresolvable for a few
      // milliseconds. That is not a broken scenario, and it is the whole
      // reason the watchdog waits out a grace period and looks again
      // instead of reporting on the first miss.
      document.body.innerHTML = `<a data-testid="settings-link">Settings</a>`;
      const onUnavailable = vi.fn();
      await start(
        [{ action: "highlight", target: HelpTarget.SettingsLink, description: "here" }],
        onUnavailable,
      );
      expect(await waitFor(() => popoverText() === "here")).toBe(true);

      const parent = document.body;
      const node = document.querySelector('[data-testid="settings-link"]')!;
      node.remove();
      await new Promise((resolve) => setTimeout(resolve, 60));
      parent.appendChild(node);

      await new Promise((resolve) => setTimeout(resolve, 800));
      expect(onUnavailable).not.toHaveBeenCalled();
    }, 15_000);

    it("stops watching the target once the tour has ended", async () => {
      // The watchdog outliving its tour would surface "unavailable" onto
      // a screen the user already left — the same late-report hazard the
      // provider's abort guard exists for, arriving from the other side.
      document.body.innerHTML = `<a data-testid="settings-link">Settings</a>`;
      const onUnavailable = vi.fn();
      const cancel = await start(
        [{ action: "highlight", target: HelpTarget.SettingsLink, description: "here" }],
        onUnavailable,
      );
      expect(await waitFor(() => popoverText() === "here")).toBe(true);

      cancel();
      document.querySelector('[data-testid="settings-link"]')!.remove();

      await new Promise((resolve) => setTimeout(resolve, 800));
      expect(onUnavailable).not.toHaveBeenCalled();
    }, 15_000);

    it("tolerates a re-render that swaps the target node for an equivalent one", async () => {
      // React replacing a node is not a scenario failure. The watchdog
      // re-queries the selector rather than holding the node it was
      // handed, so this must stay silent.
      document.body.innerHTML = `<a data-testid="settings-link">Settings</a>`;
      const onUnavailable = vi.fn();
      await start(
        [{ action: "highlight", target: HelpTarget.SettingsLink, description: "here" }],
        onUnavailable,
      );
      expect(await waitFor(() => popoverText() === "here")).toBe(true);

      const old = document.querySelector('[data-testid="settings-link"]')!;
      const replacement = document.createElement("a");
      replacement.setAttribute("data-testid", "settings-link");
      replacement.textContent = "Settings";
      old.replaceWith(replacement);

      await new Promise((resolve) => setTimeout(resolve, 800));
      expect(onUnavailable).not.toHaveBeenCalled();
    }, 15_000);
  });

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
      <a data-testid="settings-notifications">Notifications</a>`;
    const cancel = await start([
      { action: "click", target: HelpTarget.SettingsLink, description: "tap settings" },
      { action: "highlight", target: HelpTarget.SettingsNotifications, description: "here is help" },
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
