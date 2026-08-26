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

/** jsdom computes no layout, so every rect is zero-sized and
 *  `isVisible` — which checks size before anything else, precisely
 *  because a `peer sr-only` input passes `checkVisibility()` — would
 *  call every element invisible. A branch condition needs a real size
 *  to ever hold. */
function paint(testId: string): void {
  const el = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  el!.getBoundingClientRect = () =>
    ({
      width: 40,
      height: 40,
      top: 0,
      left: 0,
      right: 40,
      bottom: 40,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
}

/** The Next button Driver.js is currently painting. */
function clickNext(): void {
  document.querySelector<HTMLElement>(".driver-popover-next-btn")!.click();
}

/** What the Next button SAYS — "Next" or "Done".
 *
 *  The label, not the button's `display`, is what reports whether
 *  Driver.js believes a step follows this one: `x()` sets
 *  `nextButton.style.display` purely from `showButtons`, while `B()`
 *  sets `nextBtnText` to "Done" exactly when `I(e, t+1, 1)` finds
 *  nothing after the current index. Both are copied in when the popover
 *  is built and neither is refreshed afterwards. */
function nextBtnLabel(): string | null | undefined {
  return document.querySelector(".driver-popover-next-btn")?.textContent;
}

/** Driver.js renders `{{total}}` from the length of the array it holds
 *  at the moment it builds a popover, and never re-renders it — so this
 *  is the only way to see which array a step was painted against. */
function progressText(): string | null {
  return (
    document.querySelector(".driver-popover-progress-text")?.textContent ?? null
  );
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

  describe("a navigate step", () => {
    // The things this task adds that the mocked TourRenderer.test.ts cannot
    // see: no Next button on the popover (there `showButtons` is asserted
    // directly, but not that the real popover honours it), a tap on a ROW
    // INSIDE the container advancing by bubbling, a tap on the container's
    // own whitespace NOT advancing it, and the container's own
    // disappearance — the ordinary consequence of the tap unmounting its
    // screen — never being reported as a failure.
    function gigList(): void {
      document.body.innerHTML = `
        <div data-testid="gig-list">
          <a data-testid="gig-row" href="#">Row 1</a>
        </div>`;
    }

    it("advances on a tap inside its container, shows no Next, and does not report the container leaving", async () => {
      gigList();
      const onUnavailable = vi.fn();

      await start(
        [
          {
            action: "navigate",
            target: HelpTarget.GigList,
            route: "/gigs/:id",
            description: "tap a gig",
          },
          { action: "highlight", target: HelpTarget.GigStatus, description: "here it is" },
        ],
        onUnavailable,
      );
      expect(await waitFor(() => popoverText() === "tap a gig")).toBe(true);
      // Same rule as a click step: it advances by being done. Driver.js
      // keeps the button in the DOM either way — `showButtons` only
      // toggles its inline `display` — so the visible-to-the-user
      // property is that style, not the element's presence.
      expect(
        document.querySelector<HTMLElement>(".driver-popover-next-btn")?.style
          .display,
      ).toBe("none");

      // The listener sits on `gig-list`; this tap lands on a row inside
      // it and reaches the listener only by bubbling. Nothing here tells
      // the tour which row was chosen — that is the point.
      document
        .querySelector<HTMLElement>('[data-testid="gig-row"]')!
        .dispatchEvent(new Event("click", { bubbles: true }));

      // The unmount and the next screen's mount are NOT simultaneous in
      // production: the tap leaves `/gigs` immediately, but `GigDetail`
      // only paints once its data has loaded. Collapsing both into one
      // synchronous DOM write — as an earlier version of this test did —
      // lets `watchTarget`'s MutationObserver record `gig-list` gone and
      // `gig-status` arrived in the SAME record, and Driver re-highlights
      // onto the new target well inside `TARGET_GRACE_MS` (250ms),
      // disconnecting the observer before its pending timer ever fires.
      // That made the test pass whether or not the watchdog was actually
      // suppressed for navigate — a mutation test on the production code
      // confirmed it (see the task report). Separating the two writes by
      // more than the grace period is what makes the gap real.
      document.body.innerHTML = "";
      await new Promise((resolve) => setTimeout(resolve, 400));
      document.body.innerHTML = `<div data-testid="gig-status">Status</div>`;

      expect(await waitFor(() => popoverText() === "here it is")).toBe(true);
      // Outlasts the watchdog's own grace period a second time, now that
      // it has settled onto the new step's target — proving nothing fired
      // quietly in the background after the popover moved on.
      await new Promise((resolve) => setTimeout(resolve, 800));
      expect(onUnavailable).not.toHaveBeenCalled();
    }, 15_000);

    it("does not advance on a tap that lands on the container's own whitespace, not a row", async () => {
      // `gig-list` is `space-y-3` — 12px gaps between rows, inside the
      // div, hitting the div itself. Driver's own
      // `.driver-active .driver-active-element * { pointer-events: auto }`
      // makes the whole spotlighted container live, so a thumb landing
      // there fires this listener exactly like a row would, unless the
      // listener itself tells the two apart.
      gigList();
      const container = document.querySelector<HTMLElement>('[data-testid="gig-list"]')!;

      await start([
        {
          action: "navigate",
          target: HelpTarget.GigList,
          route: "/gigs/:id",
          description: "tap a gig",
        },
        { action: "highlight", target: HelpTarget.GigStatus, description: "here it is" },
      ]);
      expect(await waitFor(() => popoverText() === "tap a gig")).toBe(true);

      // Dispatched on the container itself, not on `gig-row` — the same
      // event a tap on the gap between rows would produce.
      container.dispatchEvent(new Event("click", { bubbles: true }));

      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(popoverText()).toBe("tap a gig");
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

  it("resolves a branch against the DOM as it is when the tour reaches it", async () => {
    // The whole point of expanding lazily. This branch's condition is
    // FALSE when the tour starts and true by the time the tour gets to
    // it — which is exactly what a navigate step does to the page.
    // Flattening up front, as this file used to, locks in the wrong
    // alternative and spotlights a control the user will never see.
    //
    // It opens on a CLICK for a reason. A branch that nothing the user
    // does precedes is asking about the screen the tour opened on, so
    // `runTour` still resolves that one before `drive()` — see the
    // step-1 branch test below for why that has to stay true. Laziness
    // is for what comes after an interaction, and an interaction is
    // therefore what this test has to put in front of the branch.
    //
    // Three leading steps, not one, so the timing is decided rather
    // than raced: `readyToGrow` fires no earlier than the second-to-last
    // known step, which is index 1 here — after the element below has
    // been inserted.
    document.body.innerHTML = `
      <a data-testid="gig-status">Status</a>
      <a data-testid="gig-break">Break</a>
      <a data-testid="gig-payments">Payments</a>`;
    paint("gig-status");
    paint("gig-break");
    paint("gig-payments");

    const onUnavailable = vi.fn();
    await start(
      [
        { action: "click", target: HelpTarget.GigStatus, description: "one" },
        { action: "highlight", target: HelpTarget.GigBreak, description: "two" },
        { action: "highlight", target: HelpTarget.GigPayments, description: "three" },
        {
          action: "branch",
          branches: [
            {
              id: "appeared",
              when: { type: "target-visible", target: HelpTarget.GigOverride },
              steps: [
                {
                  action: "highlight",
                  target: HelpTarget.GigOverride,
                  description: "appeared",
                },
              ],
            },
            {
              id: "absent",
              when: { type: "target-missing", target: HelpTarget.GigOverride },
              steps: [
                {
                  action: "highlight",
                  target: HelpTarget.GigStatus,
                  description: "absent",
                },
              ],
            },
          ],
        },
      ],
      onUnavailable,
    );

    expect(await waitFor(() => popoverText() === "one")).toBe(true);

    // The control the branch asks about arrives only now, while the
    // tour is already driving.
    document.body.insertAdjacentHTML(
      "beforeend",
      '<input data-testid="gig-override" />',
    );
    paint("gig-override");

    // A click step advances by being done, so this is the tap, not Next.
    document
      .querySelector<HTMLElement>('[data-testid="gig-status"]')!
      .dispatchEvent(new Event("click", { bubbles: true }));
    expect(await waitFor(() => popoverText() === "two")).toBe(true);
    clickNext();
    expect(await waitFor(() => popoverText() === "three")).toBe(true);
    clickNext();

    expect(await waitFor(() => popoverText() === "appeared")).toBe(true);
    expect(onUnavailable).not.toHaveBeenCalled();
  });

  it("shows a real Next and the whole total on step 0 when the branch sits at step 1", async () => {
    // `configure-notifications`, `configure-working-hours` and
    // `set-up-email-capture` all have this shape, and it is the one that
    // regressed when branch resolution first went lazy: with only step 0
    // known at `drive()` time, Driver painted "1 of 1" and a DONE button
    // on it. Growing afterwards advances correctly but cannot relabel
    // what is already on screen — `B()` copies both the label and
    // `{{total}}` when it builds the popover and never looks again.
    //
    // Nothing the user does precedes this branch, so it asks about the
    // screen `startRoute` already landed on and `runTour` resolves it
    // before driving. Step 0 must therefore look exactly as it did
    // before this task.
    document.body.innerHTML = `
      <a data-testid="gig-status">Status</a>
      <a data-testid="gig-break">Break</a>
      <a data-testid="gig-payments">Payments</a>`;
    paint("gig-status");
    paint("gig-break");
    paint("gig-payments");

    const onUnavailable = vi.fn();
    await start(
      [
        { action: "highlight", target: HelpTarget.GigStatus, description: "one" },
        {
          action: "branch",
          branches: [
            {
              id: "showing",
              when: { type: "target-visible", target: HelpTarget.GigBreak },
              steps: [
                {
                  action: "highlight",
                  target: HelpTarget.GigBreak,
                  description: "two",
                },
              ],
            },
          ],
        },
        {
          action: "highlight",
          target: HelpTarget.GigPayments,
          description: "three",
        },
      ],
      onUnavailable,
    );

    expect(await waitFor(() => popoverText() === "one")).toBe(true);
    // "Next", not "Done" — Driver found a step after this one.
    expect(nextBtnLabel()).toBe("Next");
    // And not "1 of 1": the branch behind it was already resolved.
    expect(progressText()).toBe("1 of 3");
    expect(onUnavailable).not.toHaveBeenCalled();
  }, 15_000);

  it("resolves the branch a step ahead of the boundary, not when Next is pressed", async () => {
    // Separates the two paths that can expand a branch. `advance`'s
    // await is a safety net and would also get the user there, so the
    // test above cannot tell which one ran. This one can: `{{total}}`
    // is painted from the array Driver holds at that instant, so the
    // boundary step reads "3 of 4" only if the branch was already
    // resolved BEFORE it was painted. The safety net would leave it
    // "3 of 3" with a Done button and expand afterwards.
    //
    // A click step first, so the eager pre-`drive()` loop stops and the
    // branch really is resolved lazily.
    document.body.innerHTML = `
      <a data-testid="gig-status">Status</a>
      <a data-testid="gig-break">Break</a>
      <a data-testid="gig-payments">Payments</a>
      <input data-testid="gig-override" />`;
    paint("gig-status");
    paint("gig-break");
    paint("gig-payments");
    paint("gig-override");

    const onUnavailable = vi.fn();
    await start(
      [
        { action: "click", target: HelpTarget.GigStatus, description: "tap" },
        { action: "highlight", target: HelpTarget.GigBreak, description: "two" },
        { action: "highlight", target: HelpTarget.GigPayments, description: "three" },
        {
          action: "branch",
          branches: [
            {
              id: "appeared",
              when: { type: "target-visible", target: HelpTarget.GigOverride },
              steps: [
                {
                  action: "highlight",
                  target: HelpTarget.GigOverride,
                  description: "four",
                },
              ],
            },
          ],
        },
      ],
      onUnavailable,
    );

    expect(await waitFor(() => popoverText() === "tap")).toBe(true);
    document
      .querySelector<HTMLElement>('[data-testid="gig-status"]')!
      .dispatchEvent(new Event("click", { bubbles: true }));

    // `readyToGrow` does not fire at index 0 — the boundary is index 2,
    // and one step of lead time means index 1. So this popover is
    // painted against the three steps known so far.
    expect(await waitFor(() => popoverText() === "two")).toBe(true);
    expect(progressText()).toBe("2 of 3");

    // Entering index 1 is what starts the resolve-ahead. Outlast
    // `settleBranch`'s 250ms debounce by a wide margin, then advance
    // without giving `advance` anything to await.
    await new Promise((resolve) => setTimeout(resolve, 600));
    clickNext();

    expect(await waitFor(() => popoverText() === "three")).toBe(true);
    // The assertion the whole lead time exists for: painted against the
    // GROWN array, so a real Next rather than a Done that is not done.
    expect(progressText()).toBe("3 of 4");
    expect(nextBtnLabel()).toBe("Next");

    clickNext();
    expect(await waitFor(() => popoverText() === "four")).toBe(true);
    expect(onUnavailable).not.toHaveBeenCalled();
  }, 15_000);

  it("ends the tour on a terminal step inside a branch", async () => {
    // record-work's `no-gigs-yet` shape: the alternative ends, and the
    // step written after the branch is never reached.
    document.body.innerHTML = `
      <a data-testid="gig-add">Add</a>
      <a data-testid="gig-status">Status</a>`;
    paint("gig-add");
    paint("gig-status");

    const onUnavailable = vi.fn();
    await start(
      [
        {
          action: "branch",
          branches: [
            {
              id: "no-gigs-yet",
              when: { type: "target-missing", target: HelpTarget.GigFilters },
              steps: [
                {
                  action: "highlight",
                  target: HelpTarget.GigAdd,
                  description: "nothing yet",
                  end: true,
                },
              ],
            },
          ],
        },
        {
          action: "highlight",
          target: HelpTarget.GigStatus,
          description: "unreachable",
        },
      ],
      onUnavailable,
    );

    expect(await waitFor(() => popoverText() === "nothing yet")).toBe(true);
    // One step only, so the button is Done and pressing it ends the
    // tour rather than moving to "unreachable".
    clickNext();
    expect(await waitFor(() => driverResidue().popover === false)).toBe(true);
    expect(onUnavailable).not.toHaveBeenCalled();
  });
});
