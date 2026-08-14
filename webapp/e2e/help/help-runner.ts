/**
 * Executes a HelpScenario against a live Playwright page and returns a
 * trace of what ran.
 *
 * This is what proves a documented workflow is still executable, not
 * merely describable: unlike TourRenderer.ts, which shows a person what
 * to do and waits for them to do it, this performs every action itself.
 * A UI change that breaks a documented workflow therefore fails CI here
 * instead of silently making the help wrong.
 */
import { expect, type Locator, type Page } from "@playwright/test";
import { targetSelector, type HelpTarget } from "../../src/help/targets.ts";
import type {
  BranchStep,
  HelpBranch,
  HelpCondition,
  HelpScenario,
  HelpStep,
} from "../../src/help/types.ts";

export interface HelpRunTrace {
  scenarioId: string;
  /** Branch ids taken, in order. Asserted by the suite. */
  branchesTaken: string[];
  stepsRun: number;
}

/**
 * How long to wait for a branch to settle, and how long a candidate must
 * keep holding before it is trusted.
 *
 * Mirrors TourRenderer.ts's `settleBranch`, but with a wider stability
 * window than that function's 250ms default. Settings.tsx's `blocked`
 * state depends on a real `getPushConfig()` round trip, so `push-toggle`
 * can render first and get swapped for `push-unavailable` a moment
 * later — committing to whichever branch looks satisfied on the first
 * check would lock onto that flicker and contradict the scenario's own
 * `expectedCiBranches`.
 *
 * Playwright is MORE exposed to this than the tour: a spec navigates and
 * starts driving the scenario immediately, with no human reaction time
 * between page load and the first assertion to let the data arrive
 * first. Concretely, on `/settings` the branch step can run at t≈0; if
 * the local wrangler round trip for `getPushConfig()` takes longer than
 * a 250ms window, `push-toggle` is still the only thing visible at the
 * re-check, `push-available` settles, and the runner clicks the real
 * subscribe button before ever seeing `push-unavailable` replace it.
 * 750ms is a single, cheap dial turn against a 10s budget (7.5% of it)
 * that buys real headroom for a local round trip without adding a
 * second piece of state (e.g. "held for two consecutive polls") to keep
 * consistent across debounce iterations — a static, longer window is
 * simpler to reason about than a counter that has to survive
 * `expect.poll`'s own retry cadence.
 */
const BRANCH_APPEAR_TIMEOUT_MS = 10_000;
const BRANCH_STABLE_MS = 750;

/** A step after any branch has already been resolved — the only shape
 *  `performAction` needs to handle. Named locally, the same way
 *  TourRenderer.ts has its own `FlatStep`; there is no shared type to
 *  import for it. */
type ActionStep = Exclude<HelpStep, BranchStep>;

/**
 * Thrown by this module. Carries the scenario, step index, action,
 * target and (when inside one) branch that failed — a bare locator
 * timeout does not say which documented workflow broke, this does.
 *
 * Callers that catch an error already of this type rethrow it as-is
 * (see `runSteps`) rather than wrapping it again: it was built at the
 * point closest to the actual failure and already carries the most
 * specific context available.
 */
export class HelpScenarioError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HelpScenarioError";
  }
}

/** Thrown by `conditionHolds` when reading a condition's target itself
 *  fails, before `resolveBranch`'s own deadline — a duplicate testid
 *  tripping Playwright's strict mode is the concrete case (see item 5's
 *  discussion on `conditionHolds`). Kept distinct from a plain `Error`
 *  so `resolveBranch` can tell "a candidate's own check blew up" apart
 *  from "the poll ran out of time waiting for one to settle" and let
 *  the former's real, specific message stand as-is instead of being
 *  overwritten by the latter's generic detail text. */
class BranchConditionCheckError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BranchConditionCheckError";
  }
}

function stepFailure(params: {
  scenario: HelpScenario;
  stepIndex: number;
  action: string;
  target: HelpTarget | undefined;
  branchId: string | undefined;
  /** The real underlying failure, if there was one. Always chained onto
   *  the returned error via `Error.cause` when it is an `Error` — never
   *  discarded, even when `detail` overrides what's shown as the
   *  headline message (see `detail`). */
  cause: unknown;
  /** Overrides the cause's own message as the final line. Used where the
   *  real cause would otherwise read as a diagnosis of something it
   *  isn't — e.g. a branch-resolution timeout whose `cause` might be
   *  `expect.poll`'s own clamped deadline error, or the test's overall
   *  timeout, neither of which is "this branch's condition never
   *  stabilised" even though that's the useful thing to say up front.
   *  The real cause is still attached either way. */
  detail?: string;
}): HelpScenarioError {
  const lines = [
    `Scenario: ${params.scenario.id}`,
    `Step: ${params.stepIndex} (${params.action})`,
  ];
  if (params.target !== undefined) {
    lines.push(`Target: ${params.target.id} (kind=${params.target.kind})`);
  }
  if (params.branchId !== undefined) {
    lines.push(`Branch: ${params.branchId}`);
  }
  const causeError = params.cause instanceof Error ? params.cause : undefined;
  lines.push(params.detail ?? (causeError !== undefined ? causeError.message : String(params.cause)));

  return new HelpScenarioError(
    lines.join("\n"),
    causeError !== undefined ? { cause: causeError } : undefined,
  );
}

function locatorFor(page: Page, target: HelpTarget): Locator {
  // Every locator goes through targetSelector, never getTestId: a
  // switch's testid sits on the sr-only input (targets.ts), and clicking
  // that passes while proving nothing a user could do.
  return page.locator(targetSelector(target));
}

/** Describes a branch step's candidates for a failure message: which
 *  target each one is waiting on and what state it wants that target
 *  in. "Which selector stopped matching" is the actual next question
 *  once a branch fails to resolve, and branch ids alone don't answer
 *  it. */
function describeBranchCandidates(branches: HelpBranch[]): string {
  return branches
    .map((branch) => `${branch.id} (${branch.when.type} ${branch.when.target.id})`)
    .join(", ");
}

/** A synchronous-feeling read of whether a condition holds RIGHT NOW —
 *  `Locator.isVisible()` does not auto-wait, which is exactly what a
 *  branch-settling check needs (see `resolveBranch`). Mirrors
 *  TourRenderer.ts's `conditionHolds`, which does the same read against
 *  the DOM directly instead of through a Playwright locator.
 *
 *  No `.first()`: this file's policy is that a duplicate testid is a
 *  real bug, not something to paper over by silently picking one match,
 *  and Playwright's own strict mode already enforces that everywhere
 *  else a locator resolves a target (`click`, `fill`, `selectOption`,
 *  `expect(...).toBeVisible()`) — verified `isVisible()` throws under
 *  strict mode the same way those do, so leaving it unqualified here
 *  keeps every locator in this file behind one consistent rule instead
 *  of two.
 *
 *  `deadline` (the caller's own `Date.now() + BRANCH_APPEAR_TIMEOUT_MS`,
 *  computed once in `resolveBranch`) is what makes this conditional
 *  rather than a blanket swallow. Only PAST it is a thrown error treated
 *  as "couldn't tell, so does not hold": `expect.poll` does not cancel
 *  or attach a rejection handler to a callback still in flight once its
 *  own deadline is reached, so an iteration paused mid
 *  `waitForTimeout` when that happens resumes into this call against a
 *  page that may already be tearing down, and by that point the poll
 *  has already given up — nothing reads this call's result, so treating
 *  "couldn't tell" as "does not hold" changes nothing about which
 *  branch gets chosen; it only stops that orphaned rejection from
 *  surfacing as unhandled-rejection noise on a test that is already
 *  failing for the real reason.
 *
 *  BEFORE the deadline, a thrown error is propagated as a
 *  `BranchConditionCheckError` instead — swallowing it there would be
 *  the exact bug removing `.first()` was meant to fix: a duplicate
 *  testid behind a branch's own target would read as "condition not met
 *  yet" indistinguishably from a genuinely-not-ready one, burn the full
 *  `BRANCH_APPEAR_TIMEOUT_MS` budget, and surface only as the generic
 *  "no branch condition held stably" — exactly the kind of masking this
 *  file's whole policy exists to avoid. Verified empirically that
 *  `expect.poll` does not retry a thrown callback (it propagates
 *  immediately, in ~5ms against a 10s timeout in a scratch check against
 *  `packages/isomorphic/timeoutRunner.ts`'s `pollAgainstDeadline`), so
 *  this reaches `resolveBranch`'s catch on the very first failing check,
 *  not after waiting anything out. */
async function conditionHolds(
  page: Page,
  condition: HelpCondition,
  deadline: number,
): Promise<boolean> {
  let visible: boolean;
  try {
    visible = await locatorFor(page, condition.target).isVisible();
  } catch (error) {
    if (Date.now() >= deadline) return false;
    const message = error instanceof Error ? error.message : String(error);
    throw new BranchConditionCheckError(
      `checking condition for target "${condition.target.id}" failed: ${message}`,
      error instanceof Error ? { cause: error } : undefined,
    );
  }
  return condition.type === "target-visible" ? visible : !visible;
}

async function findHoldingBranch(
  page: Page,
  branches: HelpBranch[],
  deadline: number,
): Promise<HelpBranch | undefined> {
  for (const branch of branches) {
    if (await conditionHolds(page, branch.when, deadline)) return branch;
  }
  return undefined;
}

/**
 * Resolves a branch step against the live page.
 *
 * Ports TourRenderer.ts's `settleBranch` discipline: a candidate whose
 * condition merely holds on one check is not trusted until the SAME
 * candidate's own condition still holds after a short, bounded pause —
 * never "does some branch hold", which would happily accept a
 * different one flickering into view instead. `expect.poll` supplies
 * the outer wait/retry (a real Playwright synchronisation primitive,
 * not a hand-rolled `waitForTimeout` loop); the one bounded
 * `page.waitForTimeout` inside it is purely the debounce, not used to
 * wait for anything to appear.
 *
 * No branch holding — even after the full timeout — is a hard failure:
 * a scenario whose branches have all stopped matching is exactly the
 * stale help this suite exists to catch, so it must throw rather than
 * fall through as a no-op.
 *
 * `branchId` here is the ENCLOSING branch (undefined at the top level) —
 * this branch step's own id doesn't exist yet, resolving it is the
 * point of this function — so a failure can say which already-taken
 * branch this nested one lives inside.
 */
async function resolveBranch(
  page: Page,
  scenario: HelpScenario,
  step: BranchStep,
  stepIndex: number,
  branchId: string | undefined,
): Promise<HelpBranch> {
  const candidateSummary = describeBranchCandidates(step.branches);
  // Computed once, up front, so every check across the whole poll shares
  // the same boundary — see conditionHolds's doc for why this is what
  // lets a pre-deadline strict-mode violation propagate instead of
  // being swallowed like a post-deadline orphaned check.
  const deadline = Date.now() + BRANCH_APPEAR_TIMEOUT_MS;
  let settled: HelpBranch | undefined;

  try {
    await expect
      .poll(
        async () => {
          const candidate = await findHoldingBranch(page, step.branches, deadline);
          if (candidate === undefined) return false;

          // Bounded debounce for a still-settling async condition (see
          // the module doc above) — not a general wait primitive, and
          // not what makes this loop eventually succeed or time out;
          // expect.poll owns that.
          await page.waitForTimeout(BRANCH_STABLE_MS);
          if (!(await conditionHolds(page, candidate.when, deadline))) return false;

          settled = candidate;
          return true;
        },
        { timeout: BRANCH_APPEAR_TIMEOUT_MS },
      )
      .toBe(true);
  } catch (cause) {
    if (cause instanceof BranchConditionCheckError) {
      // A candidate's own check blew up (see conditionHolds) — not "no
      // branch condition held stably". Its own message already says
      // exactly what's wrong (a duplicate testid, most concretely), so
      // no synthetic `detail` here: stepFailure falls back to the
      // cause's own message as the headline, and it's still chained
      // onto Error.cause too.
      throw stepFailure({
        scenario,
        stepIndex,
        action: "branch",
        target: undefined,
        branchId,
        cause,
      });
    }
    // `cause` here is the REAL failure — expect.poll's own clamped
    // timeout error, most likely, since a thrown condition-check error
    // was just ruled out above. It is not discarded: `detail` overrides
    // only the headline message, `cause` is still chained onto the
    // thrown error via Error.cause, so the actual diagnosis is one
    // `.cause` away rather than replaced by a guess that may not be
    // true — a plain 30s test-timeout must not read as "this branch's
    // condition never stabilised" when it might just be the test's own
    // budget running out for an unrelated reason.
    throw stepFailure({
      scenario,
      stepIndex,
      action: "branch",
      target: undefined,
      branchId,
      cause,
      detail:
        `no branch condition held stably within ${BRANCH_APPEAR_TIMEOUT_MS}ms ` +
        `(candidates: ${candidateSummary})`,
    });
  }

  if (settled === undefined) {
    // Unreachable in practice — expect.poll only resolves `.toBe(true)`
    // once `settled` has been set — but this keeps the return type
    // honest without a non-null assertion, and fails just as loudly if
    // that ever stops being true.
    throw stepFailure({
      scenario,
      stepIndex,
      action: "branch",
      target: undefined,
      branchId,
      cause: undefined,
      detail: `no branch condition held (candidates: ${candidateSummary})`,
    });
  }

  return settled;
}

/** The USER performs nothing here — this runner performs the action
 *  itself, which is the whole point of it existing alongside
 *  TourRenderer.ts. */
async function performAction(page: Page, step: ActionStep): Promise<void> {
  switch (step.action) {
    case "highlight":
      await expect(locatorFor(page, step.target)).toBeVisible();
      return;
    case "click":
      await locatorFor(page, step.target).click();
      return;
    case "input":
      await locatorFor(page, step.target).fill(step.value ?? "");
      return;
    case "select":
      if (step.value === undefined) {
        // `.selectOption("")` would try to select a real option whose
        // value is the empty string, which usually doesn't exist —
        // failing with a Playwright "option not found" error that reads
        // like a UI regression. This is a scenario-authoring mistake
        // instead: every SelectStep must say which option it means.
        throw new Error(
          `select step for target "${step.target.id}" has no value — a ` +
            "SelectStep must specify which option to choose",
        );
      }
      await locatorFor(page, step.target).selectOption(step.value);
      return;
    case "external":
      // Browser/OS UI — metadata only, nothing executable exists to
      // drive.
      return;
    default: {
      // Exhaustiveness guard: if HelpStep ever grows a sixth action
      // (types.ts's own comment on NavigateStep anticipates exactly
      // this), `step` here stops being `never` and this line fails to
      // compile — turning a silently-skipped, stepsRun-still-incremented
      // step into a build failure instead of a scenario reporting green
      // while doing less than it claims.
      const exhaustive: never = step;
      throw new Error(`unhandled help step action: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** Hands out ever-increasing step indices across an entire scenario run,
 *  including recursion into a taken branch's own steps — so a step
 *  nested inside a branch is numbered where it actually sits in the
 *  scenario, not restarted at 0 for each branch's step list. Matches
 *  the worked example in the spec: `configure-notifications`' branch
 *  step is index 1, so the click inside whichever branch it resolves to
 *  is index 2, not 0. */
function makeStepCursor(): { next(): number } {
  let n = 0;
  return { next: () => n++ };
}

async function runSteps(
  page: Page,
  scenario: HelpScenario,
  steps: HelpStep[],
  trace: HelpRunTrace,
  branchId: string | undefined,
  cursor: { next(): number },
): Promise<void> {
  for (const step of steps) {
    const index = cursor.next();

    if (step.action === "branch") {
      // No try/catch here: resolveBranch (and, by the same construction
      // recursively, this function) never lets anything but a fully
      // attributed HelpScenarioError escape, so there is nothing left
      // for this call site to add — an earlier version wrapped this in
      // a try/catch whose branchId-carrying fallback could never run,
      // since resolveBranch's own thrown error was always already a
      // HelpScenarioError by the time it got here.
      const taken = await resolveBranch(page, scenario, step, index, branchId);
      trace.branchesTaken.push(taken.id);
      await runSteps(page, scenario, taken.steps, trace, taken.id, cursor);
      continue;
    }

    try {
      await performAction(page, step);
    } catch (cause) {
      if (cause instanceof HelpScenarioError) throw cause;
      throw stepFailure({
        scenario,
        stepIndex: index,
        action: step.action,
        target: "target" in step ? step.target : undefined,
        branchId,
        cause,
      });
    }
    // Counts only executed leaf steps, matching TourRenderer.ts's
    // `flatten()` — which replaces a branch step with its taken steps
    // rather than counting the branch node itself. The two adapters
    // must agree on "how many steps is this scenario": a future doc
    // generator reading both would otherwise see them disagree about a
    // scenario neither actually treats differently.
    trace.stepsRun += 1;
  }
}

/**
 * Executes a scenario's steps against `page`, in order, performing every
 * action itself rather than instructing a person to.
 *
 * Throws a `HelpScenarioError` — naming the scenario, step, action,
 * target and (if applicable) branch — the moment anything does not
 * match what the scenario describes. `startRoute` is handled by the
 * caller's fixture (`prepareHelpScenario`) before this runs; there is no
 * navigate step in the model.
 */
export async function runHelpScenario(
  page: Page,
  scenario: HelpScenario,
): Promise<HelpRunTrace> {
  const trace: HelpRunTrace = {
    scenarioId: scenario.id,
    branchesTaken: [],
    stepsRun: 0,
  };

  await runSteps(page, scenario, scenario.steps, trace, undefined, makeStepCursor());

  return trace;
}
