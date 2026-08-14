/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HelpTarget, dayToggle, targetSelector } from "../targets.ts";
import type { BranchStep, ClickStep, HighlightStep } from "../types.ts";

/** jsdom never computes layout, so every element's rect is zero-sized by
 *  default; a target-visible test needs a stubbed rect to ever hold.
 *
 *  The rect is not a jsdom-only crutch, though. `isVisible` checks size
 *  before anything else in every environment, precisely because
 *  `checkVisibility()` reports a `peer sr-only` input — `display:block`,
 *  clipped to a pixel — as visible. So what these tests pin down is a
 *  real-browser property, not an artefact of the fallback path. */
function stubVisible(testId: string, size = { width: 40, height: 40 }): void {
  document.body.innerHTML = `<a data-testid="${testId}">Settings</a>`;
  const el = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  el!.getBoundingClientRect = () =>
    ({
      ...size,
      top: 0,
      left: 0,
      right: size.width,
      bottom: size.height,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
}

describe("flatten", () => {
  it("passes a branch-free step list through unchanged", async () => {
    const { flatten } = await import("./TourRenderer.ts");
    const steps: HighlightStep[] = [
      { action: "highlight", target: HelpTarget.SettingsLink, description: "a" },
      { action: "highlight", target: HelpTarget.SettingsHelp, description: "b" },
    ];

    await expect(flatten(steps, new AbortController().signal)).resolves.toEqual(steps);
  });

  it("takes the first branch whose target-visible condition holds", async () => {
    const { flatten } = await import("./TourRenderer.ts");
    stubVisible("settings-link");
    const taken: HighlightStep = {
      action: "highlight",
      target: HelpTarget.SettingsHelp,
      description: "taken",
    };
    const notTaken: HighlightStep = {
      action: "highlight",
      target: HelpTarget.SettingsHelp,
      description: "not-taken",
    };
    const branch: BranchStep = {
      action: "branch",
      branches: [
        {
          id: "visible",
          when: { type: "target-visible", target: HelpTarget.SettingsLink },
          steps: [taken],
        },
        {
          id: "fallback",
          when: { type: "target-missing", target: HelpTarget.SettingsLink },
          steps: [notTaken],
        },
      ],
    };

    await expect(flatten([branch], new AbortController().signal)).resolves.toEqual([taken]);
  });

  it("takes a target-missing branch when the element is absent", async () => {
    const { flatten } = await import("./TourRenderer.ts");
    document.body.innerHTML = "";
    const taken: HighlightStep = {
      action: "highlight",
      target: HelpTarget.SettingsHelp,
      description: "taken",
    };
    const notTaken: HighlightStep = {
      action: "highlight",
      target: HelpTarget.SettingsHelp,
      description: "not-taken",
    };
    const branch: BranchStep = {
      action: "branch",
      branches: [
        {
          id: "visible",
          when: { type: "target-visible", target: HelpTarget.SettingsLink },
          steps: [notTaken],
        },
        {
          id: "missing",
          when: { type: "target-missing", target: HelpTarget.SettingsLink },
          steps: [taken],
        },
      ],
    };

    await expect(flatten([branch], new AbortController().signal)).resolves.toEqual([taken]);
  });

  it("interleaves resolved branch steps with the plain steps around them", async () => {
    const { flatten } = await import("./TourRenderer.ts");
    document.body.innerHTML = "";
    const before: HighlightStep = {
      action: "highlight",
      target: HelpTarget.SettingsLink,
      description: "before",
    };
    const taken: HighlightStep = {
      action: "highlight",
      target: HelpTarget.SettingsHelp,
      description: "taken",
    };
    const after: HighlightStep = {
      action: "highlight",
      target: HelpTarget.SettingsNotifications,
      description: "after",
    };
    const branch: BranchStep = {
      action: "branch",
      branches: [
        {
          id: "missing",
          when: { type: "target-missing", target: HelpTarget.SettingsLink },
          steps: [taken],
        },
      ],
    };

    await expect(
      flatten([before, branch, after], new AbortController().signal),
    ).resolves.toEqual([before, taken, after]);
  });

  it("a 1×1 sr-only node does not count as visible", async () => {
    const { flatten } = await import("./TourRenderer.ts");
    // The exact shape Toggle's real <input> has: present in the DOM,
    // but a 1x1 box — precisely the node this system must never treat
    // as "visible" (see targets.ts's own comment on the switch trap).
    // `isVisible` rules this out on size, which is the only check that
    // can: the node is `display:block` and merely clipped, so
    // `checkVisibility()` calls it visible whatever options it is given.
    stubVisible("settings-link", { width: 1, height: 1 });
    const notTaken: HighlightStep = {
      action: "highlight",
      target: HelpTarget.SettingsHelp,
      description: "not-taken",
    };
    const taken: HighlightStep = {
      action: "highlight",
      target: HelpTarget.SettingsHelp,
      description: "taken",
    };
    const branch: BranchStep = {
      action: "branch",
      branches: [
        {
          id: "visible",
          when: { type: "target-visible", target: HelpTarget.SettingsLink },
          steps: [notTaken],
        },
        {
          id: "missing",
          when: { type: "target-missing", target: HelpTarget.SettingsLink },
          steps: [taken],
        },
      ],
    };

    await expect(flatten([branch], new AbortController().signal)).resolves.toEqual([taken]);
  });

  it("returns null when no branch matches before the timeout", async () => {
    const { flatten } = await import("./TourRenderer.ts");
    // Present AND visible, so "target-missing" never holds — the DOM
    // never changes during the wait, so this genuinely never matches
    // rather than timing out for an unrelated reason.
    stubVisible("settings-link");
    const branch: BranchStep = {
      action: "branch",
      branches: [
        {
          id: "never",
          when: { type: "target-missing", target: HelpTarget.SettingsLink },
          steps: [
            { action: "highlight", target: HelpTarget.SettingsHelp, description: "x" },
          ],
        },
      ],
    };

    // A short branchTimeoutMs, not the real 10s default — this is
    // exactly what that parameter exists for.
    await expect(
      flatten([branch], new AbortController().signal, 20),
    ).resolves.toBeNull();
  });

  it("stops promptly once the signal aborts, instead of waiting out the timeout", async () => {
    const { flatten } = await import("./TourRenderer.ts");
    document.body.innerHTML = "";
    const controller = new AbortController();
    const branch: BranchStep = {
      action: "branch",
      branches: [
        {
          id: "never",
          when: { type: "target-visible", target: HelpTarget.SettingsLink },
          steps: [
            { action: "highlight", target: HelpTarget.SettingsHelp, description: "x" },
          ],
        },
      ],
    };

    controller.abort();
    const started = Date.now();
    await expect(flatten([branch], controller.signal, 10_000)).resolves.toBeNull();
    // Well under the 10s timeout — proves the abort short-circuited the
    // wait rather than the wait happening to be fast this run.
    expect(Date.now() - started).toBeLessThan(500);
  });
});

/** A fake Driver.js instance plus the config it was built with, so a
 *  test can invoke its hooks the way the real library would. */
interface FakeDriver {
  drive: ReturnType<typeof vi.fn>;
  moveNext: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
}

// Real elements, not mocks: `runTour`'s click-advance wiring calls
// `document.querySelector` itself (resolveOperableElement), so the DOM
// has to actually contain the nodes it is looking for.
function renderToggle(testId: string, inputId: string): { input: HTMLInputElement; span: HTMLElement } {
  document.body.innerHTML = `
    <label class="inline-flex h-11 items-center">
      <input id="${inputId}" type="checkbox" role="switch" class="peer sr-only" data-testid="${testId}" />
      <span aria-hidden="true" class="relative h-6 w-11"></span>
    </label>`;
  return {
    input: document.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`)!,
    span: document.querySelector<HTMLElement>("span[aria-hidden='true']")!,
  };
}

describe("runTour", () => {
  let driverConfig: Record<string, unknown> | undefined;
  let fakeInstance: FakeDriver;

  beforeEach(async () => {
    vi.resetModules();
    document.body.innerHTML = "";
    driverConfig = undefined;

    vi.doMock("driver.js/dist/driver.css", () => ({}));
    vi.doMock("driver.js", () => ({
      driver: vi.fn((config: Record<string, unknown>) => {
        driverConfig = config;
        fakeInstance = {
          drive: vi.fn(),
          moveNext: vi.fn(),
          destroy: vi.fn(() => {
            (driverConfig?.["onDestroyed"] as (() => void) | undefined)?.();
          }),
        };
        return fakeInstance;
      }),
    }));
  });

  /** Invokes the hook the way the real library does — and the emphasis
   *  is on *the way*. `driver.js.mjs`'s `B(e,t,n)` rebuilds the step as
   *  `{...i, popover: {...}}` on every highlight, so the object reaching
   *  `onHighlightStarted` is a clone, never the one we handed over.
   *
   *  Two rounds of this file passed while production was entirely
   *  broken, because the fake passed the original object straight back
   *  and made an identity-keyed lookup look sound. Cloning here is what
   *  keeps these fast tests honest; TourRenderer.driver.test.ts is what
   *  proves the clone shape is right in the first place. */
  function highlightStarted(index: number, element: Element | undefined): void {
    const steps = driverConfig?.["steps"] as Array<Record<string, unknown>>;
    const onHighlightStarted = driverConfig?.["onHighlightStarted"] as
      | ((el: Element | undefined, step: unknown, opts: unknown) => void)
      | undefined;
    const original = steps[index]!;
    const clone = { ...original, popover: { ...(original["popover"] as object) } };
    onHighlightStarted?.(element, clone, {});
  }

  it("maps each step to a DriveStep with a targetSelector element and matching popover", async () => {
    const { runTour } = await import("./TourRenderer.ts");
    document.body.innerHTML = `<a data-testid="settings-link">Settings</a>`;
    const scenario = {
      id: "s",
      title: "Scenario title",
      category: "settings" as const,
      steps: [
        {
          action: "highlight" as const,
          target: HelpTarget.SettingsLink,
          title: "Step title",
          description: "Step description",
        },
      ],
    };

    await runTour(scenario, { signal: new AbortController().signal, onUnavailable: vi.fn() });

    const steps = driverConfig?.["steps"] as Array<{ element: string; popover: { title: string; description: string } }>;
    expect(steps).toHaveLength(1);
    expect(steps[0]!.element).toBe(targetSelector(HelpTarget.SettingsLink));
    expect(steps[0]!.popover.title).toBe("Step title");
    expect(steps[0]!.popover.description).toBe("Step description");
  });

  it("shows only Close on a click step, and Next/Previous/Close on other steps", async () => {
    const { runTour } = await import("./TourRenderer.ts");
    const scenario = {
      id: "s",
      title: "T",
      category: "settings" as const,
      steps: [
        { action: "click" as const, target: HelpTarget.SettingsLink, description: "click" },
        { action: "highlight" as const, target: HelpTarget.SettingsHelp, description: "highlight" },
        { action: "external" as const, externalType: "browser-ui" as const, description: "ext" },
      ],
    };

    await runTour(scenario, { signal: new AbortController().signal, onUnavailable: vi.fn() });

    const steps = driverConfig?.["steps"] as Array<{ popover: { showButtons: string[] } }>;
    expect(steps[0]!.popover.showButtons).toEqual(["close"]);
    expect(steps[1]!.popover.showButtons).toEqual(["next", "previous", "close"]);
    expect(steps[2]!.popover.showButtons).toEqual(["next", "previous", "close"]);
  });

  it("waits long until the user's first interaction, then short", async () => {
    const { runTour } = await import("./TourRenderer.ts");
    const scenario = {
      id: "s",
      title: "T",
      category: "settings" as const,
      steps: [
        // Step 0 is racing the initial data load, not just a render:
        // `startScenario` waits for the route, and Settings only mounts
        // AvailabilitySection once useSettings' query resolves. A short
        // wait here calls a healthy app broken on a slow connection.
        { action: "highlight" as const, target: HelpTarget.SettingsLink, description: "a" },
        { action: "click" as const, target: HelpTarget.SettingsHelp, description: "b" },
        // Past the first interaction, a late target is one re-render
        // away — no network — so five seconds of dead air buys nothing.
        { action: "highlight" as const, target: HelpTarget.SettingsNotifications, description: "c" },
      ],
    };

    await runTour(scenario, { signal: new AbortController().signal, onUnavailable: vi.fn() });

    const steps = driverConfig?.["steps"] as Array<{ waitForElement: number }>;
    expect(steps[0]!.waitForElement).toBe(5_000);
    // The interaction step's own target is part of the screen the tour
    // opened on, so it is still on the long wait.
    expect(steps[1]!.waitForElement).toBe(5_000);
    expect(steps[2]!.waitForElement).toBe(1_000);
  });

  it("gives step 0 the long wait even when the scenario opens on an interaction", async () => {
    const { runTour } = await import("./TourRenderer.ts");
    const scenario = {
      id: "s",
      title: "T",
      category: "settings" as const,
      // open-settings' exact shape. Nothing precedes step 0, so nothing
      // else can grant it the long wait — it has to be the default.
      steps: [
        { action: "click" as const, target: HelpTarget.SettingsLink, description: "a" },
      ],
    };

    await runTour(scenario, { signal: new AbortController().signal, onUnavailable: vi.fn() });

    const steps = driverConfig?.["steps"] as Array<{ waitForElement: number }>;
    expect(steps[0]!.waitForElement).toBe(5_000);
  });

  it("counts select and input as first interactions, not just click", async () => {
    const { runTour } = await import("./TourRenderer.ts");
    // types.ts defines three action steps, and a `select` that reveals
    // something downstream is no different from a `click` that does.
    for (const action of ["select", "input"] as const) {
      await runTour(
        {
          id: "s",
          title: "T",
          category: "settings" as const,
          steps: [
            { action, target: HelpTarget.SettingsLink, description: "a" },
            { action: "highlight" as const, target: HelpTarget.SettingsHelp, description: "b" },
          ],
        },
        { signal: new AbortController().signal, onUnavailable: vi.fn() },
      );

      // `driverConfig` is overwritten by each `driver()` call, so this
      // is the tour just built.
      const steps = driverConfig?.["steps"] as Array<{ waitForElement: number }>;
      expect(steps[0]!.waitForElement, action).toBe(5_000);
      expect(steps[1]!.waitForElement, action).toBe(1_000);
    }
  });

  it("advances on a real click for an element-kind click step", async () => {
    const { runTour } = await import("./TourRenderer.ts");
    document.body.innerHTML = `<a data-testid="settings-link">Settings</a>`;
    const el = document.querySelector<HTMLElement>(`[data-testid="settings-link"]`)!;
    const scenario = {
      id: "s",
      title: "T",
      category: "settings" as const,
      steps: [
        { action: "click" as const, target: HelpTarget.SettingsLink, description: "click" },
      ],
    };

    await runTour(scenario, { signal: new AbortController().signal, onUnavailable: vi.fn() });
    highlightStarted(0, el);
    el.dispatchEvent(new Event("click", { bubbles: true }));

    expect(fakeInstance.moveNext).toHaveBeenCalledTimes(1);
  });

  it("advances on `change`, not a click on the painted span, for a switch-kind click step", async () => {
    const { runTour } = await import("./TourRenderer.ts");
    const { input, span } = renderToggle("toggle-day-0", "day-0");
    const scenario = {
      id: "s",
      title: "T",
      category: "settings" as const,
      steps: [{ action: "click" as const, target: dayToggle(0), description: "click" } satisfies ClickStep],
    };

    await runTour(scenario, { signal: new AbortController().signal, onUnavailable: vi.fn() });
    // Driver.js resolves the switch's selector to the painted span —
    // that is what gets highlighted, even though `change` on the
    // input is what advances the tour.
    highlightStarted(0, span);

    span.dispatchEvent(new Event("click", { bubbles: true }));
    expect(fakeInstance.moveNext).not.toHaveBeenCalled();

    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(fakeInstance.moveNext).toHaveBeenCalledTimes(1);
  });

  it("does not wire a later click step's listener before Driver.js activates it", async () => {
    const { runTour } = await import("./TourRenderer.ts");
    const day0 = renderToggle("toggle-day-0", "day-0");
    document.body.insertAdjacentHTML(
      "beforeend",
      `<label><input id="day-1" type="checkbox" role="switch" class="peer sr-only" data-testid="toggle-day-1" /><span aria-hidden="true"></span></label>`,
    );
    const day1Input = document.querySelector<HTMLInputElement>(`[data-testid="toggle-day-1"]`)!;
    const scenario = {
      id: "s",
      title: "T",
      category: "settings" as const,
      steps: [
        { action: "click" as const, target: dayToggle(0), description: "step0" } satisfies ClickStep,
        { action: "click" as const, target: dayToggle(1), description: "step1" } satisfies ClickStep,
      ],
    };

    await runTour(scenario, { signal: new AbortController().signal, onUnavailable: vi.fn() });
    // Only step 0 has been activated so far — step 1's listener must
    // not exist yet.
    highlightStarted(0, day0.span);

    day1Input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(fakeInstance.moveNext).not.toHaveBeenCalled();

    // Now Driver.js actually reaches step 1, and the same interaction
    // works.
    const day1Span = document.querySelectorAll<HTMLElement>("span[aria-hidden='true']")[1];
    highlightStarted(1, day1Span);
    day1Input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(fakeInstance.moveNext).toHaveBeenCalledTimes(1);
  });

  it("reports unavailable and ends the tour when a real target never appears", async () => {
    const { runTour } = await import("./TourRenderer.ts");
    const onUnavailable = vi.fn();
    const scenario = {
      id: "s",
      title: "T",
      category: "settings" as const,
      steps: [
        { action: "highlight" as const, target: HelpTarget.SettingsLink, description: "x" },
      ],
    };

    await runTour(scenario, { signal: new AbortController().signal, onUnavailable });
    // Driver.js waited out `waitForElement` and fell back to its dummy
    // node, which it reports as `undefined`.
    highlightStarted(0, undefined);

    expect(onUnavailable).toHaveBeenCalledWith(expect.stringContaining("settings-link"));
    // Not yet: destroying from inside the hook is what leaves a
    // permanent overlay behind (driver.js.mjs's `J()` re-renders the
    // popover and restarts its rAF loop after the hook returns), so the
    // teardown is deferred out of Driver's own call stack.
    expect(fakeInstance.destroy).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(fakeInstance.destroy).toHaveBeenCalledTimes(1);
  });

  it("fails loudly, not silently, if a DriveStep cannot be correlated to its HelpStep", async () => {
    const { runTour } = await import("./TourRenderer.ts");
    document.body.innerHTML = `<a data-testid="settings-link">Settings</a>`;
    const el = document.querySelector<HTMLElement>(`[data-testid="settings-link"]`)!;
    const onUnavailable = vi.fn();
    const scenario = {
      id: "s",
      title: "T",
      category: "settings" as const,
      steps: [
        { action: "click" as const, target: HelpTarget.SettingsLink, description: "click" },
      ],
    };

    await runTour(scenario, { signal: new AbortController().signal, onUnavailable });

    // A DriveStep with the correlation stripped off — what a driver.js
    // upgrade that stopped preserving own properties across `B()`'s
    // clone would hand back. This must never be the silent no-op it was
    // for two rounds: it killed every click step.
    const original = (driverConfig?.["steps"] as Array<Record<string, unknown>>)[0]!;
    const onHighlightStarted = driverConfig?.["onHighlightStarted"] as (
      el: Element | undefined,
      step: unknown,
      opts: unknown,
    ) => void;
    onHighlightStarted(el, { element: original["element"], popover: {} }, {});

    expect(onUnavailable).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(fakeInstance.destroy).toHaveBeenCalledTimes(1);
  });

  it("does not treat an external step's own centred dummy element as a missing target", async () => {
    const { runTour } = await import("./TourRenderer.ts");
    const onUnavailable = vi.fn();
    const scenario = {
      id: "s",
      title: "T",
      category: "settings" as const,
      steps: [
        { action: "external" as const, externalType: "browser-ui" as const, description: "x" },
      ],
    };

    await runTour(scenario, { signal: new AbortController().signal, onUnavailable });
    highlightStarted(0, undefined);

    expect(onUnavailable).not.toHaveBeenCalled();
    expect(fakeInstance.destroy).not.toHaveBeenCalled();
  });

  it("drains the click listener when cancelled before the click happens, even if onDestroyed never fires", async () => {
    const { runTour } = await import("./TourRenderer.ts");
    document.body.innerHTML = `<a data-testid="settings-link">Settings</a>`;
    const el = document.querySelector<HTMLElement>(`[data-testid="settings-link"]`)!;
    const scenario = {
      id: "s",
      title: "T",
      category: "settings" as const,
      steps: [
        { action: "click" as const, target: HelpTarget.SettingsLink, description: "click" },
      ],
    };

    const cancel = await runTour(scenario, {
      signal: new AbortController().signal,
      onUnavailable: vi.fn(),
    });
    highlightStarted(0, el);

    // Cancel directly — simulating Driver.js's own onDestroyed hook NOT
    // firing during its fade-in window (C13's concern) by not calling
    // it here at all.
    cancel();

    el.dispatchEvent(new Event("click", { bubbles: true }));
    expect(fakeInstance.moveNext).not.toHaveBeenCalled();
  });

  it("does not construct a Driver.js tour for an already-abandoned attempt", async () => {
    const { runTour } = await import("./TourRenderer.ts");
    const controller = new AbortController();
    controller.abort();
    const scenario = {
      id: "s",
      title: "T",
      category: "settings" as const,
      steps: [
        { action: "highlight" as const, target: HelpTarget.SettingsLink, description: "x" },
      ],
    };

    const driverJs = await import("driver.js");

    await runTour(scenario, { signal: controller.signal, onUnavailable: vi.fn() });

    expect(vi.mocked(driverJs.driver)).not.toHaveBeenCalled();
  });
});
