/**
 * Translates HelpSteps into a Driver.js tour.
 *
 * The rule that shapes this file: the USER performs the click. Toggling
 * a working day changes what strangers see on a public availability
 * page, so a help system that clicks for you is doing something you did
 * not ask for. Click steps show no Next button; the tour advances when
 * the person actually taps the thing.
 */
import { resolveTarget, targetSelector } from "../targets.ts";
import type {
  BranchStep,
  HelpCondition,
  HelpScenario,
  HelpStep,
} from "../types.ts";
import type { HelpTarget } from "../targets.ts";
// Type-only: erased at build time, so this does not pull driver.js into
// whichever chunk imports this file — only the `await import("driver.js")`
// below does that, and it happens lazily.
import type { DriveStep } from "driver.js";

interface TourOptions {
  onUnavailable(reason: string): void;
  /** Aborted by the caller once it stops caring about this attempt —
   *  the help menu closed, another scenario started, or the route
   *  changed out from under an in-flight branch resolution. Checked
   *  between awaits so this file never keeps polling a dead DOM for a
   *  tour nobody can reach any more. */
  signal: AbortSignal;
}

/** Cancels the tour. */
export type CancelTour = () => void;

/** How long Driver.js will wait — via its own MutationObserver-based
 *  polling, see `waitForElement` below — for a step's target to appear.
 *
 *  Two values, because the two situations are not alike. A target that
 *  should already be on screen when its step is reached is either there
 *  within a frame or two of React settling, or it is gone; waiting five
 *  seconds to say so just makes the user stare at a blank popover. A
 *  target that an *earlier* step's click creates (the start-time
 *  <select> that only renders once its day has been switched on) has to
 *  outlast a state update, a re-render, and a slow device.
 *
 *  The rule that picks between them is deliberately not a dependency
 *  graph: only a user action can add DOM mid-tour, so nothing can
 *  appear late until the scenario's first click step has gone by. Every
 *  step up to and including that one gets the short wait; everything
 *  after it gets the long one.
 *
 *  The one case the short wait does not cover is a target that only
 *  exists once react-query has answered. That is what a branch step is
 *  for — `settleBranch` polls for ten seconds — and pointing an
 *  unconditional first step at data-dependent DOM is the bug, not this
 *  timeout. */
const TARGET_WAIT_MS = 1_000;
const TARGET_WAIT_AFTER_CLICK_MS = 5_000;

/** A step after branches have been resolved against the live DOM — there
 *  is nothing left for Driver.js to interpret as a branch. */
type FlatStep = Exclude<HelpStep, BranchStep>;

function isFlatStep(step: HelpStep): step is FlatStep {
  return step.action !== "branch";
}

/** Two independent checks, because neither one alone is enough.
 *
 *  The size test comes first and is never skipped. A `peer sr-only`
 *  input — the trap this system exists to avoid, see targets.ts's
 *  switch handling — is `display:block` and merely clipped to one
 *  pixel, so `checkVisibility()` reports it as **visible**. Only the
 *  rect rules it out.
 *
 *  `checkVisibility()` then adds what a rect cannot see. Its options
 *  all default to `false`, so a bare call catches `display:none` and
 *  nothing else; the flags below are what actually buy
 *  `visibility:hidden`, `opacity:0`, and skipped `content-visibility`
 *  subtrees. Where it is unavailable (jsdom), the size test stands on
 *  its own — which is exactly the property the unit tests assert, so
 *  they assert something true in a real browser too. */
function isVisible(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width <= 1 || rect.height <= 1) return false;
  if (typeof el.checkVisibility !== "function") return true;
  return el.checkVisibility({
    visibilityProperty: true,
    opacityProperty: true,
    contentVisibilityAuto: true,
  });
}

function conditionHolds(condition: HelpCondition): boolean {
  const found = resolveTarget(condition.target);
  const visible = found !== null && isVisible(found);
  return condition.type === "target-visible" ? visible : !visible;
}

/** Waits until one of the branch conditions holds. Data arrives through
 *  react-query, so neither branch is resolvable on the first frame. */
async function settleBranch(
  step: BranchStep,
  signal: AbortSignal,
  timeoutMs = 10_000,
): Promise<HelpStep[] | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !signal.aborted) {
    const hit = step.branches.find((branch) => conditionHolds(branch.when));
    if (hit !== undefined) return hit.steps;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

/** Flattens branches against the live DOM, so the tour is a plain list
 *  by the time Driver.js sees it. Exported for unit testing — this is
 *  the one piece of this file that is pure enough to test without
 *  mocking Driver.js.
 *
 *  `branchTimeoutMs` exists so tests can exercise the "no branch
 *  matched" path without waiting out the real 10s default. */
export async function flatten(
  steps: HelpStep[],
  signal: AbortSignal,
  branchTimeoutMs = 10_000,
): Promise<FlatStep[] | null> {
  const flat: FlatStep[] = [];
  for (const step of steps) {
    if (signal.aborted) return null;
    if (!isFlatStep(step)) {
      const taken = await settleBranch(step, signal, branchTimeoutMs);
      if (taken === null) return null;
      for (const inner of taken) {
        // validate.ts rejects a branch step whose own steps nest another
        // branch, so this should never happen — but if it somehow did,
        // that is the same kind of failure an unmatched branch is, not
        // a step to silently drop from the tour.
        if (!isFlatStep(inner)) return null;
        flat.push(inner);
      }
      continue;
    }
    flat.push(step);
  }
  return flat;
}

/** The literal tagged node behind a target — the element carrying the
 *  test id itself, before targets.ts's switch handling walks up to the
 *  visible span used for spotlighting. For a switch this is the
 *  operable `<input>`: listening there catches every way its state can
 *  change (tapping the switch, tapping Toggle's separate day-name
 *  `<label>`, or Tab + Space), where listening on the painted span
 *  would miss the label and keyboard paths entirely. */
function resolveOperableElement(target: HelpTarget): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `[data-testid="${CSS.escape(target.id)}"]`,
  );
}

/** Carries the HelpStep a DriveStep came from, on the DriveStep itself.
 *
 *  A Map keyed on the DriveStep object cannot work: Driver.js never
 *  hands that object back. `driver.js.mjs`'s `B(e,t,n)` returns
 *  `{...i, popover: {...}}` — a fresh clone built for every highlight —
 *  and it is the clone, not the step we authored, that reaches
 *  `onHighlightStarted`. Measured under the real library: identity
 *  comparison against the original is `false`, so a Map lookup is
 *  always `undefined` and every branch behind it is dead code.
 *
 *  Object spread copies own enumerable properties, symbol keys
 *  included, so a symbol stamped here survives that clone — also
 *  measured, not assumed. A symbol rather than a string key so nothing
 *  in Driver.js can mistake it for a step option it knows. */
const HELP_STEP = Symbol("gigsy.helpStep");

interface TaggedDriveStep extends DriveStep {
  [HELP_STEP]?: FlatStep;
}

function helpStepOf(driveStep: DriveStep | undefined): FlatStep | undefined {
  return (driveStep as TaggedDriveStep | undefined)?.[HELP_STEP];
}

export async function runTour(
  scenario: HelpScenario,
  options: TourOptions,
): Promise<CancelTour> {
  const { driver } = await import("driver.js");
  await import("driver.js/dist/driver.css");

  if (options.signal.aborted) return () => undefined;

  const flat = await flatten(scenario.steps, options.signal);
  if (options.signal.aborted) return () => undefined;
  if (flat === null) {
    options.onUnavailable("no branch matched");
    return () => undefined;
  }

  const driveSteps: TaggedDriveStep[] = [];
  // Only a user action can add DOM mid-tour, so no target can arrive
  // late until the scenario's first click step has been passed. See
  // TARGET_WAIT_MS.
  let afterClickStep = false;

  for (const step of flat) {
    const driveStep: TaggedDriveStep =
      step.action === "external"
        ? {
            popover: {
              title: step.title ?? scenario.title,
              description: step.description,
              showButtons: ["next", "previous", "close"],
            },
          }
        : {
            // A selector, not a resolved node: targets.ts's own CSS
            // form, re-queried by Driver.js every time it needs the
            // element (see `waitForElement` below). That is what makes
            // a later step reachable when its target — e.g. the
            // start-time <select> that only exists once its day has
            // been switched on — is not in the DOM yet when the tour
            // is built, only by the time this step is actually reached.
            element: targetSelector(step.target),
            waitForElement: afterClickStep
              ? TARGET_WAIT_AFTER_CLICK_MS
              : TARGET_WAIT_MS,
            popover: {
              title: step.title ?? scenario.title,
              description: step.description,
              // A click step advances by being done, not by pressing Next.
              showButtons:
                step.action === "click"
                  ? ["close"]
                  : ["next", "previous", "close"],
            },
          };
    // Stamped on the object rather than held in a side Map, because the
    // object Driver.js hands back is a clone — see HELP_STEP.
    driveStep[HELP_STEP] = step;
    driveSteps.push(driveStep);
    if (step.action === "click") afterClickStep = true;
  }

  if (options.signal.aborted) return () => undefined;

  let activeCleanup: (() => void) | null = null;
  const clearActiveCleanup = (): void => {
    activeCleanup?.();
    activeCleanup = null;
  };

  let torndown = false;
  /** The one way this tour ends. Idempotent, because the missing-target
   *  path and the caller's own cancel can both reach it.
   *
   *  It drains the click listener itself rather than relying on
   *  `onDestroyed`: destroying before Driver.js has recorded its
   *  "settled" state leaves `__activeElement`/`__activeStep` unset, and
   *  `driver.js.mjs`'s destroy only fires `onDestroyed` when both are
   *  present. Measured: `onDestroyed` count 0 on exactly that path. */
  const teardown = (): void => {
    if (torndown) return;
    torndown = true;
    clearActiveCleanup();
    tour.destroy();
  };

  /** Teardown for callers that are *inside* a Driver.js hook.
   *
   *  `driver.js.mjs`'s `J()` keeps going after `onHighlightStarted`
   *  returns: it re-sets `__transitionCallback`, renders the popover
   *  via `U(e,t,n)`, and restarts the rAF loop — all on the state
   *  `destroy()` has just reset. Destroying synchronously from the hook
   *  therefore leaves a full-screen overlay and an orphaned popover on
   *  the page for good, with `driver-active` stripped from <body> so
   *  Driver.js's own pointer-events guards no longer apply. Measured
   *  under the real library: sync destroy leaves `popover=true
   *  overlay=true bodyClass=""`; the same call from a microtask, after
   *  `J()` has finished, leaves `popover=false overlay=false` and a
   *  stopped rAF loop. */
  const endTourAfterHook = (): void => {
    queueMicrotask(teardown);
  };

  const tour = driver({
    popoverClass: "gigsy-help-popover",
    // The user must be able to operate the highlighted control.
    disableActiveInteraction: false,
    showProgress: driveSteps.length > 1,
    steps: driveSteps,
    onHighlightStarted: (element, driveStep) => {
      // Wired here, on the step Driver.js is actually about to show,
      // not up front for every click step at once — wiring them all up
      // front let an *earlier* step's highlighted container (which
      // makes every control inside it clickable) burn a *later* step's
      // listener before the tour ever reached it, with no Next button
      // to recover.
      clearActiveCleanup();

      const step = helpStepOf(driveStep);

      if (step === undefined) {
        // Unreachable: every step in `driveSteps` is stamped, and
        // Driver.js highlights nothing else. It is checked, and checked
        // *loudly*, because the last two rounds of this file both
        // shipped with this correlation broken and the failure looking
        // exactly like nothing happening — a dead click step and a
        // missing target that says so to no one. If a driver.js upgrade
        // ever stops carrying own properties through `B()`'s clone, this
        // is the line that turns that back into a visible failure
        // instead of silence (spec §3.7).
        options.onUnavailable("step could not be correlated to its HelpStep");
        endTourAfterHook();
        return;
      }

      if (element === undefined) {
        // External steps have no element at all and are always shown
        // centred on Driver's dummy node by design — it reports that
        // the same way it reports "waited out waitForElement and still
        // found nothing", so only the latter is a failure here.
        if (step.action !== "external") {
          options.onUnavailable(`target ${step.target.id} not found`);
          endTourAfterHook();
        }
        return;
      }

      if (step.action !== "click") return;

      const operable = resolveOperableElement(step.target);
      if (operable === null) return;

      // A switch's state can change by tapping the switch itself,
      // tapping Toggle's separate day-name <label>, or keyboard Tab +
      // Space — only `change` on the input catches all three; `click`
      // on the painted span catches only the first.
      const eventName = step.target.kind === "switch" ? "change" : "click";
      const onFire = (): void => tour.moveNext();
      operable.addEventListener(eventName, onFire, { once: true });
      activeCleanup = () => operable.removeEventListener(eventName, onFire);
    },
    onDestroyed: clearActiveCleanup,
  });

  tour.drive();

  // Cancelling from outside a Driver.js hook — the help menu closing, a
  // route change, unmount — is safe to do synchronously, and `teardown`
  // is idempotent if the tour has already ended itself.
  return teardown;
}
