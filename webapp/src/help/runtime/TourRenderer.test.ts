/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HelpTarget, dayToggle, targetSelector } from "../targets.ts";
import type { BranchStep, ClickStep, HighlightStep } from "../types.ts";

/** jsdom never computes layout, so every element's rect is zero-sized
 *  by default — `conditionHolds` reads a real size as "visible" (and
 *  jsdom does not implement `checkVisibility`, so this exercises the
 *  fallback path), so a target-visible test needs a stubbed rect to
 *  ever hold. */
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

  function highlightStarted(index: number, element: Element | undefined): void {
    const steps = driverConfig?.["steps"] as unknown[];
    const onHighlightStarted = driverConfig?.["onHighlightStarted"] as
      | ((el: Element | undefined, step: unknown, opts: unknown) => void)
      | undefined;
    onHighlightStarted?.(element, steps[index], {});
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
