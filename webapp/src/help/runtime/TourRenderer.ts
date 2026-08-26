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
 *  Two values, because two different things make a target late and they
 *  are orders of magnitude apart.
 *
 *  DATA ARRIVAL is the slow one, and it lands at the START of a
 *  scenario. `startScenario` waits for the ROUTE to settle, not for
 *  data: `Settings.tsx` renders `<AvailabilitySection />` only once
 *  `useSettings`' query resolves, and that query has no `staleTime` and
 *  no `initialData`, so on a cold open it is a live `GET /api/settings`.
 *  A working-hours scenario whose first step highlights
 *  `avail-working-week` is therefore racing a network round trip. Lose
 *  that race and a perfectly healthy app tells the user its help is
 *  unavailable — intermittently, on first run only, because the retry
 *  hits react-query's cache.
 *
 *  A RE-RENDER AFTER AN INTERACTION is the fast one. The start-time
 *  <select> that appears once its day is switched on costs a state
 *  update and a paint, no network, and Driver.js is watching with a
 *  MutationObserver. A second is many times what that needs, and it
 *  buys back the dead air: a target that is genuinely gone is now
 *  reported in about a second instead of five.
 *
 *  So the long wait goes to every step up to and including the
 *  scenario's first user interaction — which means step 0 always gets
 *  it, whatever it is — and the short wait to everything after. It is
 *  deliberately not a dependency graph. */
const TARGET_WAIT_BEFORE_INTERACTION_MS = 5_000;
const TARGET_WAIT_AFTER_INTERACTION_MS = 1_000;

/** A step after branches have been resolved against the live DOM — there
 *  is nothing left for Driver.js to interpret as a branch. */
type FlatStep = Exclude<HelpStep, BranchStep>;

function isFlatStep(step: HelpStep): step is FlatStep {
  return step.action !== "branch";
}

/** A step the USER performs, and therefore the only kind that can put
 *  new DOM on the page part-way through a tour. All four of types.ts's
 *  action steps count — a `select` that reveals something downstream is
 *  no different from a `click` that does, and a `navigate` replaces the
 *  whole screen. `highlight` and `external` change nothing.
 *
 *  Exported for unit testing; nothing outside this file calls it. */
export function isUserInteraction(step: FlatStep): boolean {
  return (
    step.action === "click" ||
    step.action === "input" ||
    step.action === "select" ||
    step.action === "navigate"
  );
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

/** Waits until one of the branch conditions holds, and stays true for a
 *  moment before committing to it. Data arrives through react-query, so
 *  neither branch is resolvable on the first frame — but "not yet
 *  resolvable" and "resolved to something that is about to change
 *  again" look identical to a single check. `configureNotifications` is
 *  the concrete case: `Settings.tsx`'s `blocked` depends on both a fast
 *  client-only `useEffect` and a real `getPushConfig()` round trip, so
 *  `push-toggle` can render first and get swapped for `push-unavailable`
 *  a moment later. Committing on first sight would lock onto
 *  "push-available", spotlight a control that is about to vanish, and
 *  silently contradict the scenario's own `expectedCiBranches`.
 *
 *  The fix is a debounce, not a smarter predicate: wait `stableMs`,
 *  then re-check the SAME candidate's own condition (not "does some
 *  branch hold", which would happily accept a different one flickering
 *  into view instead). If it no longer holds, that was the flicker —
 *  loop and keep waiting rather than trusting it. */
async function settleBranch(
  step: BranchStep,
  signal: AbortSignal,
  timeoutMs = 10_000,
  stableMs = 250,
): Promise<HelpStep[] | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !signal.aborted) {
    const candidate = step.branches.find((branch) => conditionHolds(branch.when));
    if (candidate !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, stableMs));
      if (signal.aborted) return null;
      if (conditionHolds(candidate.when)) return candidate.steps;
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

/** The scenario, half-resolved: the flat steps already known, and the
 *  model steps still waiting for a DOM to resolve against.
 *
 *  `flatten` loops on this until `rest` is empty. `takeUntilBranch` and
 *  `expandBranch` below return this same shape so a caller can resolve
 *  one branch at a time instead — against the screen the tour has
 *  reached rather than the one it started on — which is what `runTour`
 *  is being moved onto. */
interface Expansion {
  flat: FlatStep[];
  /** Model steps not yet resolved. Empty both when the walk reached
   *  the natural end of the list and when a terminal step closed it
   *  early — deliberately not distinguished, because no consumer has
   *  ever needed to: "nothing left to resolve" is the only question
   *  anyone asks. */
  rest: HelpStep[];
}

/** Appends steps until a terminal step (stop, drop the rest) or a
 *  branch (stop, leave the branch at the head of `rest`). Touches no
 *  DOM: it never resolves a branch itself, which is what lets the
 *  caller decide WHEN that resolution happens. */
function takeUntilBranch(steps: HelpStep[]): Expansion {
  const flat: FlatStep[] = [];
  for (const [i, step] of steps.entries()) {
    if (!isFlatStep(step)) return { flat, rest: steps.slice(i) };
    flat.push(step);
    if (step.end === true) return { flat, rest: [] };
  }
  return { flat, rest: [] };
}

/** Resolves the ONE branch at the head of `steps` against the live DOM
 *  and appends everything up to the next branch. `null` is the same
 *  hard failure it has always been: no branch condition held.
 *
 *  Exported so its `{flat, rest}` contract — in particular, that `rest`
 *  stops at the NEXT branch rather than running past it — can be
 *  pinned directly; see the `expandBranch` tests below. That is the
 *  exact property the next task's loop needs in order to resolve one
 *  branch at a time. */
export async function expandBranch(
  steps: HelpStep[],
  signal: AbortSignal,
  branchTimeoutMs = 10_000,
  branchStableMs = 250,
): Promise<Expansion | null> {
  const head = steps[0];
  if (head === undefined || isFlatStep(head)) return takeUntilBranch(steps);

  const taken = await settleBranch(head, signal, branchTimeoutMs, branchStableMs);
  if (taken === null) return null;

  const inner = takeUntilBranch(taken);
  // A branch's steps may not themselves contain a branch — validate.ts
  // rejects that — so `inner.rest` should always be empty here. If it
  // ever is not, those steps would be silently dropped from the tour,
  // which is the same kind of failure an unmatched branch is: report
  // it, do not swallow it. A local structural check, not a trusted
  // invariant, so it holds for hand-built step lists that never went
  // through the validator.
  if (inner.rest.length > 0) return null;

  // Did the taken alternative END, or merely finish? Both leave
  // `inner.rest` empty, and only the first may drop what follows the
  // branch — so ask the steps themselves. `takeUntilBranch` stops ON a
  // terminal step, so a terminal alternative is exactly one whose last
  // appended step carries the flag.
  if (inner.flat.at(-1)?.end === true) return { flat: inner.flat, rest: [] };

  const after = takeUntilBranch(steps.slice(1));
  return { flat: [...inner.flat, ...after.flat], rest: after.rest };
}

/** Flattens every branch against the live DOM in one pass, measuring
 *  every condition against the screen the tour is on when it is called.
 *
 *  That is fine for a scenario that begins and ends in one place, and
 *  wrong the moment one navigates: a branch asking about a control on a
 *  screen the user has not opened yet would be answered against the
 *  screen they started on. `takeUntilBranch` and `expandBranch` above
 *  exist so a caller can resolve one branch at a time instead, as the
 *  tour reaches each one — which is what `runTour` is being moved onto.
 *
 *  `branchTimeoutMs` exists so tests can exercise the "no branch
 *  matched" path without waiting out the real 10s default;
 *  `branchStableMs` so a flicker test doesn't need the real 250ms. */
export async function flatten(
  steps: HelpStep[],
  signal: AbortSignal,
  branchTimeoutMs = 10_000,
  branchStableMs = 250,
): Promise<FlatStep[] | null> {
  // The old loop's `for (const step of steps)` checked this on its
  // very first iteration too. `takeUntilBranch` below touches no DOM
  // and cannot itself observe an abort, so without this check a
  // pre-aborted signal on a branch-free (or terminal-step-first) list
  // would fall straight through to `return flat` — turning "help
  // unavailable" into "here is a tour" in exactly the direction that
  // matters.
  if (signal.aborted) return null;
  let state = takeUntilBranch(steps);
  const flat = [...state.flat];

  while (state.rest.length > 0) {
    if (signal.aborted) return null;
    const grown = await expandBranch(state.rest, signal, branchTimeoutMs, branchStableMs);
    if (grown === null) return null;
    flat.push(...grown.flat);
    state = grown;
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

/** How long a target may be absent before its step is called dead.
 *
 *  Not zero, because React legitimately unmounts and remounts a node
 *  within a frame, and a selector that misses for one microtask is not
 *  a broken scenario. Short, because this only ever runs after the step
 *  was already on screen — the target existed a moment ago, so there is
 *  no initial load left to wait out. */
const TARGET_GRACE_MS = 250;

/** Watches a step's target for the rest of that step's life, and calls
 *  `onGone` if it leaves the page for good.
 *
 *  Driver.js resolves `element` exactly once, when the step is entered,
 *  and never looks again — so a target that disappears *after* that
 *  moment produces no `waitForElement` timeout, no dummy node, and no
 *  `onHighlightStarted(undefined, …)`. Nothing reports it, because from
 *  Driver.js's point of view nothing went wrong.
 *
 *  That is not a corner case here, it is the ordinary consequence of
 *  how a click step advances. Our listener sits on the control itself,
 *  so it runs before React's delegated handler has even seen the event,
 *  let alone re-rendered. `moveNext()` therefore resolves the next
 *  step's target against the DOM as it was *before* the interaction
 *  took effect. Measured on the working-hours scenario started from a
 *  day that was already on: the hook fires for the select step with
 *  `element=SELECT/start-day-0/connected=true`, and only afterwards
 *  does the row collapse and take the select with it — leaving a
 *  popover anchored to a detached node, no spotlight, and no failure
 *  ever reported.
 *
 *  Re-queries the selector rather than tracking the node it was given:
 *  a re-render that swaps one node for an equivalent one is not a
 *  failure, only an empty result is. */
function watchTarget(target: HelpTarget, onGone: () => void): () => void {
  const selector = targetSelector(target);
  let pending: ReturnType<typeof setTimeout> | null = null;

  const cancelPending = (): void => {
    if (pending === null) return;
    clearTimeout(pending);
    pending = null;
  };

  // One decision point, deliberately: a miss only ever *schedules* the
  // verdict, and the verdict is reached by looking again. Cancelling the
  // timer the moment the target reappears would work too, but then two
  // separate guards would each be enough on their own, and a broken one
  // could hide behind the other.
  const check = (): void => {
    if (pending !== null) return;
    if (document.querySelector(selector) !== null) return;
    pending = setTimeout(() => {
      pending = null;
      if (document.querySelector(selector) === null) onGone();
    }, TARGET_GRACE_MS);
  };

  const observer = new MutationObserver(check);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  return () => {
    observer.disconnect();
    cancelPending();
  };
}

/** Driver.js's own per-step cleanup, applied to anything it left
 *  behind. Enforces the invariant the spotlight depends on: exactly one
 *  element carries `driver-active-element` at any moment.
 *
 *  Driver.js does not guarantee that in our usage, and the reason is a
 *  timing window, not nesting or our selector strings — both of those
 *  were measured and cleared. `J()` removes the class from
 *  `o = getState("__activeElement") || t`, but `__activeElement` is
 *  assigned only in the *settled* branch of the rAF loop, which needs
 *  `elapsed >= duration` (400ms). Advance inside that window and
 *  `__activeElement` is still undefined, so `o` falls back to `t` — the
 *  element arriving — and Driver.js dutifully removes the class from
 *  the node it is about to add it to, never touching the outgoing one.
 *  Measured across a delay sweep: 50/200/380ms leave two highlighted,
 *  420/600/900ms leave one, and siblings behave exactly like nested
 *  targets.
 *
 *  That window is not an edge case for this file. A click step advances
 *  on the user's own tap or `change`, which is routinely faster than
 *  400ms, and the consequences are worse than a second outline:
 *  Driver.js's `.driver-active .driver-active-element * {pointer-events:
 *  auto}` leaves the whole stale subtree interactive — the same hazard
 *  as wiring listeners up front, arriving by a different road — and the
 *  stale `aria-haspopup`/`aria-expanded`/`aria-controls` misreport the
 *  page to assistive technology (§7.5).
 *
 *  Safe to run before Driver.js's own bookkeeping: this hook is called
 *  from inside `J()` *before* it removes and re-adds the class, so the
 *  element arriving is re-marked synchronously and never flickers. */
function clearStaleHighlights(current: Element | undefined): void {
  for (const stale of document.querySelectorAll(".driver-active-element")) {
    if (stale === current) continue;
    stale.classList.remove("driver-active-element", "driver-no-interaction");
    stale.removeAttribute("aria-haspopup");
    stale.removeAttribute("aria-expanded");
    stale.removeAttribute("aria-controls");
  }
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

/** The flat steps, as Driver.js wants them.
 *
 *  Rebuilt from the whole list every time rather than appended to, so
 *  `afterFirstInteraction` is recomputed from scratch and cannot drift
 *  as branches expand. Cheap: a scenario is a dozen steps. */
function buildDriveSteps(
  scenario: HelpScenario,
  steps: FlatStep[],
): TaggedDriveStep[] {
  const driveSteps: TaggedDriveStep[] = [];
  // Everything up to and including the first thing the user does is
  // still racing the initial data load; after that, a late target is
  // only ever a re-render away. See TARGET_WAIT_BEFORE_INTERACTION_MS.
  let afterFirstInteraction = false;

  for (const step of steps) {
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
            // a later step reachable when its target — e.g. anything on
            // the screen a navigate step is about to open — is not in
            // the DOM yet when the step is built.
            element: targetSelector(step.target),
            waitForElement: afterFirstInteraction
              ? TARGET_WAIT_AFTER_INTERACTION_MS
              : TARGET_WAIT_BEFORE_INTERACTION_MS,
            popover: {
              title: step.title ?? scenario.title,
              description: step.description,
              // A click or navigate step advances by being done, not by
              // pressing Next.
              showButtons:
                step.action === "click" || step.action === "navigate"
                  ? ["close"]
                  : ["next", "previous", "close"],
            },
          };
    // Stamped on the object rather than held in a side Map, because the
    // object Driver.js hands back is a clone — see HELP_STEP.
    driveStep[HELP_STEP] = step;
    driveSteps.push(driveStep);
    // After this step, not on it: the interaction step's own target is
    // still part of the screen the tour opened on.
    //
    // A navigate step RESETS this rather than setting it. Every other
    // interaction reveals something on the screen you are already on —
    // a re-render away. A navigate step's next target is on a screen
    // that has not loaded its data yet, which is the cold-load case the
    // long budget exists for. Guarded on `isUserInteraction` so a
    // highlight after a click does not reset it.
    if (isUserInteraction(step)) afterFirstInteraction = step.action !== "navigate";
  }

  return driveSteps;
}

export async function runTour(
  scenario: HelpScenario,
  options: TourOptions,
): Promise<CancelTour> {
  const { driver } = await import("driver.js");
  await import("driver.js/dist/driver.css");

  if (options.signal.aborted) return () => undefined;

  // ── the scenario, resolved as the tour goes ──
  //
  // NOT `flatten(scenario.steps)`. Resolving every branch here would
  // measure each condition against the screen the tour STARTS on, which
  // is wrong the moment a scenario navigates: `record-work`'s pay
  // branches ask about controls on a gig the user has not opened yet.
  // help-runner.ts has always resolved branches where it reaches them;
  // this is what makes the in-app tour agree.
  let known: FlatStep[] = [];
  let rest: HelpStep[] = scenario.steps;
  let driveSteps: TaggedDriveStep[] = [];

  const absorb = (grown: Expansion): void => {
    known = [...known, ...grown.flat];
    rest = grown.rest;
  };
  absorb(takeUntilBranch(rest));

  /** Hand Driver.js the steps we know about now, mid-step, without
   *  disturbing the popover already on screen. Nothing rendered holds
   *  a reference into the array: `B()` copied out its button label and
   *  its `{{total}}` when it built the popover and never looks again,
   *  and `moveNext` re-reads `getConfig("steps")` every time. So the
   *  step being read stays exactly as it was, and the next one comes
   *  from the grown array. See `readyToGrow` for why that label is
   *  worth getting ahead of.
   *
   *  `setConfig`, deliberately, NOT `setSteps` — which would freeze the
   *  tour. `driver.js.mjs`'s `setSteps` is
   *  `d(); resetState(); setConfig({...getConfig(), steps: e})`, and
   *  `resetState()` empties the whole state bag, `activeIndex`
   *  included. Every advance path reads that: `moveNext`'s `i()` bails
   *  on `activeIndex === undefined`, so the Next button would stop
   *  working on the very step this grew for. Measured under the real
   *  library: `getActiveIndex()` is 1 before `setSteps` and `undefined`
   *  after, and the following `moveNext()` leaves the popover where it
   *  was. The `setConfig` line is the half of `setSteps` that does the
   *  work; the `d()` it also drops only cancels a pending
   *  `waitForElement`, which is another thing we do not want cancelled
   *  under a step that is still waiting for its target. */
  const rebuild = (): void => {
    driveSteps = buildDriveSteps(scenario, known);
    tour.setConfig({ ...tour.getConfig(), steps: driveSteps });
  };

  /** Resolve the branch at the head of `rest`. Single-flight: the
   *  resolve-ahead from a highlight hook and a Next press racing it
   *  must not run two `settleBranch` polls over the same branch. */
  let growing: Promise<boolean> | null = null;
  const grow = (): Promise<boolean> => {
    if (growing !== null) return growing;
    const attempt = (async () => {
      const grown = await expandBranch(rest, options.signal);
      if (grown === null || options.signal.aborted) return false;
      absorb(grown);
      rebuild();
      return true;
    })();
    growing = attempt;
    void attempt.finally(() => {
      if (growing === attempt) growing = null;
    });
    return attempt;
  };

  // A scenario that OPENS on a branch has nothing to drive until that
  // branch is resolved — `find-a-gig` is the one that does today,
  // asking on /gigs whether the list has any gigs in it yet. Resolving
  // eagerly here is not the bug above: no step has run, so the screen
  // this branch asks about is exactly the one `startRoute` landed on.
  while (known.length === 0 && rest.length > 0) {
    const grown = await expandBranch(rest, options.signal);
    if (options.signal.aborted) return () => undefined;
    if (grown === null) {
      options.onUnavailable("no branch matched");
      return () => undefined;
    }
    absorb(grown);
  }

  if (options.signal.aborted) return () => undefined;

  driveSteps = buildDriveSteps(scenario, known);

  // Everything wired for the step currently on screen: its click
  // listener and its target watchdog. Drained together when the step
  // changes or the tour ends, and safe to drain twice.
  let stepCleanups: Array<() => void> = [];
  const clearActiveCleanup = (): void => {
    const draining = stepCleanups;
    stepCleanups = [];
    for (const cleanup of draining) cleanup();
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

  /** Can the branch at the head of `rest` be resolved against the DOM
   *  the user is looking at right now?
   *
   *  The last known step is always safe — everything before the branch
   *  has been walked. One step of lead time is safe too, and worth
   *  having: it is what keeps the boundary step's button labelled Next
   *  rather than Done, since Driver decides that label from whether a
   *  next step exists at the moment it renders the popover. The
   *  exception is a last known step that NAVIGATES, whose branch asks
   *  about a screen that is not on the page yet.
   *
   *  There is not always a step to lead by. A branch at index 1 leaves
   *  `last` at 0, so the earliest resolve-ahead IS the boundary step,
   *  whose popover was rendered before the branch settled and keeps the
   *  "Done" it was built with. Pressing it still advances — `advance`
   *  calls `moveNext` on the grown array — so this costs a wrong label
   *  on that one step, not a stuck tour. Measured under the real
   *  library on the shape `notifications` and `working-hours` have. */
  const readyToGrow = (index: number | undefined): boolean => {
    if (index === undefined || rest.length === 0) return false;
    const last = known.length - 1;
    if (index === last) return true;
    return index === last - 1 && known[last]?.action !== "navigate";
  };

  /** What the Next (and Done) button does. Driver's own advance is
   *  replaced entirely by the config-level `onNextClick` below, so this
   *  has to call `moveNext` itself — including on the true final step,
   *  where `moveNext` runs off the end of the array and destroys the
   *  tour, exactly as the default would.
   *
   *  The await is the safety net for someone who reaches the last known
   *  step before the resolve-ahead has finished settling: without it
   *  they would press Done on a tour that is not over. */
  const advance = async (): Promise<void> => {
    const index = tour.getActiveIndex();
    if (index === known.length - 1 && rest.length > 0) {
      const ok = await grow();
      if (options.signal.aborted) return;
      if (!ok) {
        options.onUnavailable("no branch matched");
        teardown();
        return;
      }
    }
    tour.moveNext();
  };

  const tour = driver({
    popoverClass: "gigsy-help-popover",
    // The user must be able to operate the highlighted control.
    disableActiveInteraction: false,
    // `rest`, because a one-step tour that still has a branch to
    // resolve is not a one-step tour. The cost is that `{{total}}` is
    // read from the array Driver holds at the moment it renders each
    // popover, so it grows as branches expand — "1 of 2" then "2 of 3".
    // Deliberate: resolution runs ahead, so the total updates on a step
    // boundary rather than under the step being read, and the only
    // alternative is a fixed number (the longest path, say) that is
    // wrong for every run instead of briefly incomplete.
    showProgress: driveSteps.length > 1 || rest.length > 0,
    steps: driveSteps,
    // Replaces Driver's internal advance for every step: its `L()`
    // prefers a step's own `onNextClick`, then this, and falls back to
    // this for the Done button too because we set no `onDoneClick`.
    onNextClick: () => {
      void advance();
    },
    onHighlightStarted: (element, driveStep) => {
      // Wired here, on the step Driver.js is actually about to show,
      // not up front for every click step at once — wiring them all up
      // front let an *earlier* step's highlighted container (which
      // makes every control inside it clickable) burn a *later* step's
      // listener before the tour ever reached it, with no Next button
      // to recover.
      clearActiveCleanup();
      // Before anything else, and unconditionally: a step that failed
      // to correlate or whose target went missing still has to leave
      // the previous step's spotlight behind it.
      clearStaleHighlights(element);

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

      // Driver.js checked this target once, a moment ago, and will not
      // check it again. Everything from here on is on us: a target that
      // leaves the page mid-step has to end the scenario with the
      // banner, exactly as a target that never arrived does (§10).
      if (step.action === "external") return;
      // A navigate step's target is EXPECTED to leave the page — the
      // tap on it unmounts the screen it lives on — so the watchdog
      // must not report that. But "vanished because the user tapped"
      // and "vanished for some other reason" are different failures,
      // and only the first is success: a sync that empties the list, or
      // a re-render that drops the container for some unrelated cause,
      // would otherwise leave the tour on a dead popover until the NEXT
      // step's own budget runs out and then names the wrong target. So
      // the tap silences the watchdog (via `advanced` below), rather
      // than the step type disabling it outright.
      let advanced = false;
      stepCleanups.push(
        watchTarget(step.target, () => {
          if (advanced) return;
          options.onUnavailable(`target ${step.target.id} disappeared`);
          endTourAfterHook();
        }),
      );

      // Resolve the next branch now, against the screen this step is
      // on, so it is already expanded by the time anyone presses Next.
      // `advance` awaits it if they get there first.
      if (readyToGrow(tour.getActiveIndex())) void grow();

      if (step.action !== "click" && step.action !== "navigate") return;

      const operable = resolveOperableElement(step.target);
      if (operable === null) return;

      // A switch's state can change by tapping the switch itself,
      // tapping Toggle's separate day-name <label>, or keyboard Tab +
      // Space — only `change` on the input catches all three; `click`
      // on the painted span catches only the first.
      //
      // A navigate step's target is a container, so this listener sits
      // on the list and the tap on a row inside it arrives by bubbling.
      // That is what "the person picks their own row" means here: the
      // tour never needs to know which one.
      const eventName = step.target.kind === "switch" ? "change" : "click";
      const onFire = (event: Event): void => {
        // A navigate step's target is a CONTAINER, so a tap can land on
        // its own whitespace (e.g. `gig-list`'s `space-y-3` gaps) as
        // easily as on a row. That tap navigates nowhere, and with no
        // Next button on this step there is no way back from advancing
        // on it — so only a tap that actually hit a link or button
        // counts as the choice this step is waiting for.
        if (
          step.action === "navigate" &&
          !(event.target as Element | null)?.closest("a[href], button")
        ) {
          return;
        }
        advanced = true;
        operable.removeEventListener(eventName, onFire);
        tour.moveNext();
      };
      operable.addEventListener(eventName, onFire);
      stepCleanups.push(() =>
        operable.removeEventListener(eventName, onFire),
      );
    },
    onDestroyed: clearActiveCleanup,
  });

  tour.drive();

  // Cancelling from outside a Driver.js hook — the help menu closing, a
  // route change, unmount — is safe to do synchronously, and `teardown`
  // is idempotent if the tour has already ended itself.
  return teardown;
}
