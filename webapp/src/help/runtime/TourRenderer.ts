/**
 * Translates HelpSteps into a Driver.js tour.
 *
 * The rule that shapes this file: the USER performs the click. Toggling
 * a working day changes what strangers see on a public availability
 * page, so a help system that clicks for you is doing something you did
 * not ask for. Click steps show no Next button; the tour advances when
 * the person actually taps the thing.
 */
import { resolveTarget } from "../targets.ts";
import type {
  BranchStep,
  HelpCondition,
  HelpScenario,
  HelpStep,
} from "../types.ts";
// Type-only: erased at build time, so this does not pull driver.js into
// whichever chunk imports this file — only the `await import("driver.js")`
// below does that, and it happens lazily.
import type { DriveStep } from "driver.js";

interface TourOptions {
  onUnavailable(reason: string): void;
}

/** Cancels the tour. */
export type CancelTour = () => void;

/** A step after branches have been resolved against the live DOM — there
 *  is nothing left for Driver.js to interpret as a branch. */
type FlatStep = Exclude<HelpStep, BranchStep>;

function isFlatStep(step: HelpStep): step is FlatStep {
  return step.action !== "branch";
}

function conditionHolds(condition: HelpCondition): boolean {
  const found = resolveTarget(condition.target);
  const visible = found !== null && found.getBoundingClientRect().height > 0;
  return condition.type === "target-visible" ? visible : !visible;
}

/** Waits until one of the branch conditions holds. Data arrives through
 *  react-query, so neither branch is resolvable on the first frame. */
async function settleBranch(
  step: BranchStep,
  timeoutMs = 10_000,
): Promise<HelpStep[] | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = step.branches.find((branch) => conditionHolds(branch.when));
    if (hit !== undefined) return hit.steps;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

/** Flattens branches against the live DOM, so the tour is a plain list
 *  by the time Driver.js sees it. Exported for unit testing — this is
 *  the one piece of this file that is pure enough to test without
 *  mocking Driver.js. */
export async function flatten(steps: HelpStep[]): Promise<FlatStep[] | null> {
  const flat: FlatStep[] = [];
  for (const step of steps) {
    if (!isFlatStep(step)) {
      const taken = await settleBranch(step);
      if (taken === null) return null;
      for (const inner of taken) {
        // validate.ts rejects a branch step whose own steps nest another
        // branch, so this always holds — the guard just proves it here
        // rather than casting past the type it doesn't structurally fit.
        if (isFlatStep(inner)) flat.push(inner);
      }
      continue;
    }
    flat.push(step);
  }
  return flat;
}

export async function runTour(
  scenario: HelpScenario,
  options: TourOptions,
): Promise<CancelTour> {
  const { driver } = await import("driver.js");
  await import("driver.js/dist/driver.css");

  const flat = await flatten(scenario.steps);
  if (flat === null) {
    options.onUnavailable("no branch matched");
    return () => undefined;
  }

  const driveSteps: DriveStep[] = [];
  // Elements behind each step in `flat`, aligned by index — resolved
  // once here and reused below when wiring the click-advance listener,
  // rather than querying the DOM for the same target twice.
  const targetElements: Array<HTMLElement | null> = [];

  for (const step of flat) {
    if (step.action === "external") {
      targetElements.push(null);
      driveSteps.push({
        popover: {
          title: step.title ?? scenario.title,
          description: step.description,
          showButtons: ["next", "previous", "close"],
        },
      });
      continue;
    }

    const el = resolveTarget(step.target);
    if (el === null) {
      options.onUnavailable(`target ${step.target.id} not found`);
      return () => undefined;
    }
    targetElements.push(el);

    driveSteps.push({
      element: el,
      popover: {
        title: step.title ?? scenario.title,
        description: step.description,
        // A click step advances by being done, not by pressing Next.
        showButtons:
          step.action === "click" ? ["close"] : ["next", "previous", "close"],
      },
    });
  }

  const cleanups: Array<() => void> = [];

  const tour = driver({
    popoverClass: "gigsy-help-popover",
    // The user must be able to operate the highlighted control.
    disableActiveInteraction: false,
    showProgress: driveSteps.length > 1,
    steps: driveSteps,
    onDestroyed: () => {
      for (const cleanup of cleanups) cleanup();
      cleanups.length = 0;
    },
  });

  // Advance on the real interaction, once per click step. Driver.js's
  // own moveNext() already destroys the tour when there is no next step,
  // so the last click step needs no special case.
  flat.forEach((step, index) => {
    if (step.action !== "click") return;
    const el = targetElements[index];
    if (el === null || el === undefined) return;
    const onClick = (): void => tour.moveNext();
    el.addEventListener("click", onClick, { once: true });
    cleanups.push(() => el.removeEventListener("click", onClick));
  });

  tour.drive();

  return () => {
    tour.destroy();
  };
}
