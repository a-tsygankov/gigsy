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
 *  polling, see `waitForElement` below — for a step's target to appear
 *  before giving up. Generous enough to cover a click step's own state
 *  update settling through React (e.g. the start-time <select> that
 *  only renders once its day has been switched on), without hanging
 *  indefinitely if the target really is never coming. */
const TARGET_WAIT_MS = 5_000;

/** A step after branches have been resolved against the live DOM — there
 *  is nothing left for Driver.js to interpret as a branch. */
type FlatStep = Exclude<HelpStep, BranchStep>;

function isFlatStep(step: HelpStep): step is FlatStep {
  return step.action !== "branch";
}

/** `height > 0` alone treats a 1×1 `sr-only` node as visible — exactly
 *  the trap this system exists to avoid (targets.ts's own switch
 *  handling has to walk past exactly such a node). `checkVisibility()`
 *  additionally accounts for `display:none`, `visibility:hidden`, and
 *  content-visibility in one call; where it is unavailable, fall back
 *  to requiring real size. */
function isVisible(el: HTMLElement): boolean {
  if (typeof el.checkVisibility === "function") return el.checkVisibility();
  const rect = el.getBoundingClientRect();
  return rect.width > 1 && rect.height > 1;
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

  const driveSteps: DriveStep[] = [];
  // Correlates a hook callback's DriveStep (identity, not value — two
  // steps can share a title) back to the HelpStep it came from.
  const stepByDriveStep = new Map<DriveStep, FlatStep>();

  for (const step of flat) {
    const driveStep: DriveStep =
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
            waitForElement: TARGET_WAIT_MS,
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
    driveSteps.push(driveStep);
    stepByDriveStep.set(driveStep, step);
  }

  if (options.signal.aborted) return () => undefined;

  let activeCleanup: (() => void) | null = null;
  const clearActiveCleanup = (): void => {
    activeCleanup?.();
    activeCleanup = null;
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

      const step = stepByDriveStep.get(driveStep);

      if (element === undefined) {
        // External steps have no element at all and are always shown
        // centred on Driver's dummy node by design — it reports that
        // the same way it reports "waited out waitForElement and still
        // found nothing", so only the latter is a failure here.
        if (step !== undefined && step.action !== "external") {
          options.onUnavailable(`target ${step.target.id} not found`);
          tour.destroy();
        }
        return;
      }

      if (step === undefined || step.action !== "click") return;

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

  return () => {
    // Driver.js only fires onDestroyed once its own "settled" state has
    // been recorded, which trails a highlight by its fade duration —
    // destroying inside that window would otherwise skip the drain
    // above entirely and leak the listener. Draining here too, and
    // leaving `clearActiveCleanup` safe to call twice, closes that gap.
    clearActiveCleanup();
    tour.destroy();
  };
}
