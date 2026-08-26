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

describe("expandBranch", () => {
  // `runTour`'s whole one-branch-at-a-time loop is built on the
  // `{flat, rest}` shape `expandBranch` returns, so that shape needs
  // its own direct tests rather than staying an implementation detail
  // nobody pins. The tests it replaced observed only the collapsed
  // list — exactly the projection that discards `rest`.

  it("treats a flat head as a plain take, stopping at the next branch without resolving it", async () => {
    const { expandBranch } = await import("./TourRenderer.ts");
    document.body.innerHTML = "";
    const a: HighlightStep = {
      action: "highlight",
      target: HelpTarget.SettingsLink,
      description: "a",
    };
    const branch: BranchStep = {
      action: "branch",
      branches: [
        {
          id: "x",
          // Never rendered in this test's DOM. If `expandBranch` tried
          // to resolve this branch too, instead of leaving it in
          // `rest`, this would hang until the default 10s
          // branchTimeoutMs rather than resolving immediately.
          when: { type: "target-visible", target: HelpTarget.SettingsNotifications },
          steps: [
            { action: "highlight", target: HelpTarget.SettingsNotifications, description: "unreached" },
          ],
        },
      ],
    };

    await expect(
      expandBranch([a, branch], new AbortController().signal),
    ).resolves.toEqual({ flat: [a], rest: [branch] });
  });

  it("leaves rest headed by the next branch, without resolving that one too", async () => {
    // The exact property the next task's loop depends on: resolving
    // ONE branch at a time means the branch after it must come back
    // untouched, not pre-resolved against today's DOM.
    const { expandBranch } = await import("./TourRenderer.ts");
    stubVisible("gig-filters");
    const inFirst: HighlightStep = {
      action: "highlight",
      target: HelpTarget.GigSearch,
      description: "first",
    };
    const first: BranchStep = {
      action: "branch",
      branches: [
        {
          id: "showing",
          when: { type: "target-visible", target: HelpTarget.GigFilters },
          steps: [inFirst],
        },
      ],
    };
    const second: BranchStep = {
      action: "branch",
      branches: [
        {
          id: "never",
          // Same "would hang if resolved" tell as the test above.
          when: { type: "target-visible", target: HelpTarget.SettingsNotifications },
          steps: [
            { action: "highlight", target: HelpTarget.SettingsNotifications, description: "unreached" },
          ],
        },
      ],
    };

    await expect(
      expandBranch([first, second], new AbortController().signal),
    ).resolves.toEqual({ flat: [inFirst], rest: [second] });
  });

  it("a branch whose taken alternative ends leaves rest empty and drops what follows the branch", async () => {
    const { expandBranch } = await import("./TourRenderer.ts");
    document.body.innerHTML = "";
    const deadEnd: HighlightStep = {
      action: "highlight",
      target: HelpTarget.GigAdd,
      description: "dead end",
      end: true,
    };
    const afterTheBranch: HighlightStep = {
      action: "highlight",
      target: HelpTarget.GigStatus,
      description: "after",
    };
    const branch: BranchStep = {
      action: "branch",
      branches: [
        {
          id: "no-gigs-yet",
          when: { type: "target-missing", target: HelpTarget.GigFilters },
          steps: [deadEnd],
        },
      ],
    };

    await expect(
      expandBranch([branch, afterTheBranch], new AbortController().signal),
    ).resolves.toEqual({ flat: [deadEnd], rest: [] });
  });

  it("a branch whose taken alternative does not end appends what follows the branch", async () => {
    const { expandBranch } = await import("./TourRenderer.ts");
    stubVisible("gig-filters");
    const inBranch: HighlightStep = {
      action: "highlight",
      target: HelpTarget.GigSearch,
      description: "in branch",
    };
    const afterTheBranch: HighlightStep = {
      action: "highlight",
      target: HelpTarget.GigStatus,
      description: "after",
    };
    const branch: BranchStep = {
      action: "branch",
      branches: [
        {
          id: "showing",
          when: { type: "target-visible", target: HelpTarget.GigFilters },
          steps: [inBranch],
        },
      ],
    };

    await expect(
      expandBranch([branch, afterTheBranch], new AbortController().signal),
    ).resolves.toEqual({ flat: [inBranch, afterTheBranch], rest: [] });
  });
  // — ported from the retired `flatten` —
  //
  // `flatten` resolved every branch in one pass and `runTour` no longer
  // calls it, so it was deleted rather than left as dead code its own
  // tests kept alive. What it pinned that nothing else did is below,
  // rewritten against `expandBranch` — which is where that behaviour
  // actually lives, since `flatten` only ever looped on it.
  //
  // Three of its tests were dropped as already covered, not lost:
  // "lets a terminal step inside a branch end the whole scenario" and
  // "keeps going past a branch whose taken alternative did not end" are
  // the two `end`-semantics tests above; "returns null on an
  // already-aborted signal" pinned an entry check that only `flatten`
  // had, and the property it protected — an abandoned attempt must not
  // become a served tour — is pinned on `runTour` itself, by "does not
  // construct a Driver.js tour for an already-abandoned attempt".

  it("returns a branch-free list whole, with nothing left to resolve", async () => {
    const { expandBranch } = await import("./TourRenderer.ts");
    const steps: HighlightStep[] = [
      { action: "highlight", target: HelpTarget.SettingsLink, description: "a" },
      { action: "highlight", target: HelpTarget.SettingsNotifications, description: "b" },
    ];

    await expect(
      expandBranch(steps, new AbortController().signal),
    ).resolves.toEqual({ flat: steps, rest: [] });
  });

  it("takes the first branch whose target-visible condition holds", async () => {
    const { expandBranch } = await import("./TourRenderer.ts");
    stubVisible("settings-link");
    const taken: HighlightStep = {
      action: "highlight",
      target: HelpTarget.SettingsNotifications,
      description: "taken",
    };
    const notTaken: HighlightStep = {
      action: "highlight",
      target: HelpTarget.SettingsNotifications,
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

    await expect(
      expandBranch([branch], new AbortController().signal),
    ).resolves.toEqual({ flat: [taken], rest: [] });
  });

  it("takes a target-missing branch when the element is absent", async () => {
    const { expandBranch } = await import("./TourRenderer.ts");
    document.body.innerHTML = "";
    const taken: HighlightStep = {
      action: "highlight",
      target: HelpTarget.SettingsNotifications,
      description: "taken",
    };
    const notTaken: HighlightStep = {
      action: "highlight",
      target: HelpTarget.SettingsNotifications,
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

    await expect(
      expandBranch([branch], new AbortController().signal),
    ).resolves.toEqual({ flat: [taken], rest: [] });
  });

  it("walks a branch sitting between plain steps, one call per branch", async () => {
    // `flatten` did this in a single pass; `runTour` does it across two
    // steps of the tour, which is the whole point of the change. Two
    // explicit calls rather than a loop helper, so what the caller has
    // to do stays visible instead of hiding behind a re-implementation
    // of the function this replaced.
    const { expandBranch } = await import("./TourRenderer.ts");
    document.body.innerHTML = "";
    const before: HighlightStep = {
      action: "highlight",
      target: HelpTarget.SettingsLink,
      description: "before",
    };
    const taken: HighlightStep = {
      action: "highlight",
      target: HelpTarget.SettingsNotifications,
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
    const signal = new AbortController().signal;

    await expect(expandBranch([before, branch, after], signal)).resolves.toEqual({
      flat: [before],
      rest: [branch, after],
    });
    await expect(expandBranch([branch, after], signal)).resolves.toEqual({
      flat: [taken, after],
      rest: [],
    });
  });

  it("a 1×1 sr-only node does not count as visible", async () => {
    const { expandBranch } = await import("./TourRenderer.ts");
    // The exact shape Toggle's real <input> has: present in the DOM,
    // but a 1x1 box — precisely the node this system must never treat
    // as "visible" (see targets.ts's own comment on the switch trap).
    // `isVisible` rules this out on size, which is the only check that
    // can: the node is `display:block` and merely clipped, so
    // `checkVisibility()` calls it visible whatever options it is given.
    stubVisible("settings-link", { width: 1, height: 1 });
    const notTaken: HighlightStep = {
      action: "highlight",
      target: HelpTarget.SettingsNotifications,
      description: "not-taken",
    };
    const taken: HighlightStep = {
      action: "highlight",
      target: HelpTarget.SettingsNotifications,
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

    await expect(
      expandBranch([branch], new AbortController().signal),
    ).resolves.toEqual({ flat: [taken], rest: [] });
  });

  it("returns null when no branch matches before the timeout", async () => {
    const { expandBranch } = await import("./TourRenderer.ts");
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
            { action: "highlight", target: HelpTarget.SettingsNotifications, description: "x" },
          ],
        },
      ],
    };

    // A short branchTimeoutMs, not the real 10s default — this is
    // exactly what that parameter exists for.
    await expect(
      expandBranch([branch], new AbortController().signal, 20),
    ).resolves.toBeNull();
  });

  it("does not commit to a branch whose target only appears momentarily", async () => {
    const { expandBranch } = await import("./TourRenderer.ts");
    document.body.innerHTML = "";

    function addVisible(testId: string): HTMLElement {
      const el = document.createElement("div");
      el.setAttribute("data-testid", testId);
      el.getBoundingClientRect = () =>
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
      document.body.appendChild(el);
      return el;
    }

    // The exact race `configureNotifications` is subject to:
    // `push-toggle` renders first (client-side availability resolves in
    // a plain `useEffect`), then `getPushConfig()`'s real round trip
    // comes back and Settings.tsx swaps it for `push-unavailable`. A
    // resolver that commits on first sight would lock onto
    // "push-available" and spotlight a control that is about to vanish
    // — silently contradicting `expectedCiBranches: ["push-blocked"]`.
    const flickering = addVisible("push-toggle");

    const flickered: HighlightStep = {
      action: "highlight",
      target: HelpTarget.PushToggle,
      description: "flickered",
    };
    const settled: HighlightStep = {
      action: "highlight",
      target: HelpTarget.PushUnavailable,
      description: "settled",
    };
    const branch: BranchStep = {
      action: "branch",
      branches: [
        {
          id: "push-available",
          when: { type: "target-visible", target: HelpTarget.PushToggle },
          steps: [flickered],
        },
        {
          id: "push-blocked",
          when: { type: "target-visible", target: HelpTarget.PushUnavailable },
          steps: [settled],
        },
      ],
    };

    // Fires inside the first candidate's stability wait — before
    // `settleBranch` would otherwise have committed to it.
    setTimeout(() => {
      flickering.remove();
      addVisible("push-unavailable");
    }, 5);

    // A short branchStableMs, not the real 250ms default, so the test
    // stays fast — same reasoning as branchTimeoutMs above.
    await expect(
      expandBranch([branch], new AbortController().signal, 5_000, 30),
    ).resolves.toEqual({ flat: [settled], rest: [] });
  });

  it("stops promptly once the signal aborts, instead of waiting out the timeout", async () => {
    const { expandBranch } = await import("./TourRenderer.ts");
    document.body.innerHTML = "";
    const controller = new AbortController();
    const branch: BranchStep = {
      action: "branch",
      branches: [
        {
          id: "never",
          when: { type: "target-visible", target: HelpTarget.SettingsLink },
          steps: [
            { action: "highlight", target: HelpTarget.SettingsNotifications, description: "x" },
          ],
        },
      ],
    };

    controller.abort();
    const started = Date.now();
    await expect(
      expandBranch([branch], controller.signal, 10_000),
    ).resolves.toBeNull();
    // Well under the 10s timeout — proves the abort short-circuited the
    // wait rather than the wait happening to be fast this run.
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("stops at a terminal step and drops everything after it", async () => {
    // This exact shape — a step marked `end` with more steps written
    // after it — is one validate.ts itself rejects ("a step marked end
    // that is not the last of the scenario's own steps"). Pinning the
    // defensive behaviour on it anyway is legitimate: it is the honest
    // answer to "what does this do if something upstream ever fails to
    // enforce that rule".
    const { expandBranch } = await import("./TourRenderer.ts");
    const stop: HighlightStep = {
      action: "highlight",
      target: HelpTarget.SettingsLink,
      description: "stop",
      end: true,
    };
    const unreachable: HighlightStep = {
      action: "highlight",
      target: HelpTarget.SettingsNotifications,
      description: "unreachable",
    };

    await expect(
      expandBranch([stop, unreachable], new AbortController().signal),
    ).resolves.toEqual({ flat: [stop], rest: [] });
  });

  it("short-circuits a branch that would never settle, once an earlier terminal step already ended the walk", async () => {
    // Same "forbidden by validate.ts, legitimate to pin anyway" shape
    // as the terminal-step test above: `stop` is not the last step here
    // either.
    const { expandBranch } = await import("./TourRenderer.ts");
    const stop: HighlightStep = {
      action: "highlight",
      target: HelpTarget.SettingsLink,
      description: "stop",
      end: true,
    };
    const neverSettles: BranchStep = {
      action: "branch",
      branches: [
        {
          id: "never",
          // Never rendered in this test's DOM, so this branch would
          // hang until branchTimeoutMs if it were ever resolved. It
          // must not be: `stop` already ended the walk.
          when: { type: "target-visible", target: HelpTarget.SettingsNotifications },
          steps: [
            { action: "highlight", target: HelpTarget.SettingsNotifications, description: "unreached" },
          ],
        },
      ],
    };

    const started = Date.now();
    await expect(
      expandBranch([stop, neverSettles], new AbortController().signal, 10_000),
    ).resolves.toEqual({ flat: [stop], rest: [] });
    // Well under the 10s branchTimeoutMs — proves the terminal step
    // stopped the walk before `neverSettles` was ever resolved, rather
    // than this happening to be a fast run of the real wait.
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("drops the steps written after a terminal step inside a branch, not just the ones after the branch", async () => {
    // Another shape validate.ts forbids on its own terms (a step
    // marked `end` that is not the last of ITS OWN branch's steps),
    // pinned for the same reason as the other two: it is what actually
    // happens if that rule is ever not enforced.
    const { expandBranch } = await import("./TourRenderer.ts");
    stubVisible("gig-filters");
    const deadEnd: HighlightStep = {
      action: "highlight",
      target: HelpTarget.GigAdd,
      description: "stop here",
      end: true,
    };
    const unreachableInBranch: HighlightStep = {
      action: "highlight",
      target: HelpTarget.GigSearch,
      description: "never reached",
    };
    const branch: BranchStep = {
      action: "branch",
      branches: [
        {
          id: "showing",
          when: { type: "target-visible", target: HelpTarget.GigFilters },
          steps: [deadEnd, unreachableInBranch],
        },
      ],
    };

    await expect(
      expandBranch([branch], new AbortController().signal),
    ).resolves.toEqual({ flat: [deadEnd], rest: [] });
  });
});

/** A fake Driver.js instance plus the config it was built with, so a
 *  test can invoke its hooks the way the real library would. */
interface FakeDriver {
  drive: ReturnType<typeof vi.fn>;
  moveNext: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  /** The real library sets `activeIndex` in `m()` before it fires
   *  `onHighlightStarted`, and `runTour` reads it from inside that hook
   *  to decide whether the next branch is safe to resolve yet. */
  getActiveIndex: ReturnType<typeof vi.fn>;
  getConfig: ReturnType<typeof vi.fn>;
  setConfig: ReturnType<typeof vi.fn>;
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
  /** Whatever step `highlightStarted` last pretended to enter. */
  let activeIndex: number | undefined;

  beforeEach(async () => {
    vi.resetModules();
    document.body.innerHTML = "";
    driverConfig = undefined;
    activeIndex = undefined;

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
          getActiveIndex: vi.fn(() => activeIndex),
          getConfig: vi.fn(() => driverConfig),
          // The real `setConfig` replaces the config the instance reads
          // from, which is the same object these tests inspect — so a
          // mid-tour rebuild has to be visible here too, or `steps`
          // assertions would go on describing the tour as it started.
          setConfig: vi.fn((config: Record<string, unknown>) => {
            driverConfig = config;
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
    activeIndex = index;
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
        { action: "highlight" as const, target: HelpTarget.SettingsNotifications, description: "highlight" },
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
        { action: "click" as const, target: HelpTarget.SettingsNotifications, description: "b" },
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
            { action: "highlight" as const, target: HelpTarget.SettingsNotifications, description: "b" },
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

  it("does not poll a second time for a branch that already failed to settle", async () => {
    // Two things can ask for the same branch: the resolve-ahead fired
    // from `onHighlightStarted`, which swallows its result, and the
    // Next press behind it. The single-flight promise only merges them
    // while the first is still running — once it has settled, a second
    // call would start a whole new `settleBranch`, and `settleBranch`
    // polls right up to its 10s deadline before giving up. That is
    // roughly twenty seconds of dead air before the banner, on a tour
    // that was already known to be broken ten seconds in.
    //
    // Deliberately slow (the real 10s budget is not injectable through
    // `runTour`), because the whole property is about what happens
    // AFTER the first budget is spent. Pressing Next earlier would only
    // pin the single-flight, which is a different guard.
    const { runTour } = await import("./TourRenderer.ts");
    stubVisible("settings-link");
    document.body.insertAdjacentHTML(
      "beforeend",
      '<a data-testid="settings-help">Help</a>',
    );
    const onUnavailable = vi.fn();
    const scenario = {
      id: "s",
      title: "T",
      category: "settings" as const,
      steps: [
        // An interaction, so the eager pre-`drive()` loop stops here and
        // the branch behind it is resolved lazily.
        { action: "click" as const, target: HelpTarget.SettingsLink, description: "tap" },
        // And a highlight after it, so the step that reaches the branch
        // is one that actually renders a Next button. `readyToGrow` also
        // needs the interaction PERFORMED before it will resolve, which
        // is what entering this step means.
        { action: "highlight" as const, target: HelpTarget.SettingsNotifications, description: "read" },
        {
          action: "branch" as const,
          branches: [
            {
              id: "never",
              // `settings-link` is present and visible throughout, so
              // this never holds and the DOM never changes.
              when: {
                type: "target-missing" as const,
                target: HelpTarget.SettingsLink,
              },
              steps: [
                {
                  action: "highlight" as const,
                  target: HelpTarget.SettingsNotifications,
                  description: "unreached",
                },
              ],
            },
          ],
        },
      ],
    };

    await runTour(scenario, {
      signal: new AbortController().signal,
      onUnavailable,
    });
    // Entering the last known step starts the resolve-ahead.
    highlightStarted(1, document.querySelector('[data-testid="settings-help"]')!);

    // Outlast `settleBranch`'s full 10s deadline, so the first attempt
    // has genuinely finished and recorded its verdict.
    await new Promise((resolve) => setTimeout(resolve, 10_600));
    expect(onUnavailable).not.toHaveBeenCalled();

    const started = Date.now();
    (driverConfig?.["onNextClick"] as () => void)();
    await vi.waitFor(() => expect(onUnavailable).toHaveBeenCalled(), {
      timeout: 2_000,
    });

    expect(onUnavailable).toHaveBeenCalledWith("no branch matched");
    // The point: answered from the recorded verdict, not by spending
    // another 10s budget on a DOM that has not changed.
    expect(Date.now() - started).toBeLessThan(1_000);
  }, 20_000);

  it("advances a click step through the same guard the Next button uses", async () => {
    // A click or navigate step renders `showButtons: ["close"]`, so the
    // tap on the control is the ONLY pointer path forward. Wiring it
    // straight to `moveNext` bypassed every protection `advance` adds:
    // with a branch still unresolved behind such a step, `moveNext` ran
    // off the end of a one-step array and destroyed the tour, banner
    // and all. Driven here through the real listener, not by calling
    // the hook, because the listener is the thing that was wrong.
    const { runTour } = await import("./TourRenderer.ts");
    stubVisible("settings-link");
    document.body.insertAdjacentHTML(
      "beforeend",
      '<a data-testid="settings-help">Help</a>',
    );
    const onUnavailable = vi.fn();
    const scenario = {
      id: "s",
      title: "T",
      category: "settings" as const,
      steps: [
        { action: "click" as const, target: HelpTarget.SettingsLink, description: "tap" },
        {
          action: "branch" as const,
          branches: [
            {
              id: "showing",
              when: {
                type: "target-visible" as const,
                target: HelpTarget.SettingsLink,
              },
              steps: [
                {
                  action: "highlight" as const,
                  target: HelpTarget.SettingsNotifications,
                  description: "behind the branch",
                },
              ],
            },
          ],
        },
      ],
    };

    await runTour(scenario, {
      signal: new AbortController().signal,
      onUnavailable,
    });
    highlightStarted(0, document.querySelector('[data-testid="settings-link"]')!);
    // Only the click step is known at this point; the branch is not.
    expect((driverConfig?.["steps"] as unknown[]).length).toBe(1);

    document
      .querySelector<HTMLElement>('[data-testid="settings-link"]')!
      .dispatchEvent(new Event("click", { bubbles: true }));

    // The tap awaited the branch instead of walking off the end, so the
    // step behind it exists by the time the tour moves.
    await vi.waitFor(
      () => expect((driverConfig?.["steps"] as unknown[]).length).toBe(2),
      { timeout: 3_000 },
    );
    expect(fakeInstance.moveNext).toHaveBeenCalledTimes(1);
    expect(onUnavailable).not.toHaveBeenCalled();
  }, 15_000);

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

describe("isUserInteraction", () => {
  it("counts a navigate step, so later targets get the short wait", async () => {
    // A navigate step puts a whole new screen on the page, so anything
    // after it is a re-render away rather than a cold data load away —
    // the exact distinction the two wait budgets draw.
    const { isUserInteraction } = await import("./TourRenderer.ts");
    expect(
      isUserInteraction({
        action: "navigate",
        target: HelpTarget.GigList,
        route: "/gigs/:id",
        description: "Tap one.",
      }),
    ).toBe(true);
  });

  it("still does not count a highlight", async () => {
    const { isUserInteraction } = await import("./TourRenderer.ts");
    expect(
      isUserInteraction({
        action: "highlight",
        target: HelpTarget.GigList,
        description: "Look.",
      }),
    ).toBe(false);
  });
});
