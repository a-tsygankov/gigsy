/**
 * The help domain model. Plain data: no DOM access, no Playwright, no
 * React. Every adapter reads this and none of them owns it.
 */
import type { HelpTarget } from "./targets.ts";

export type HelpScenarioId = string;

/** Sections in the help menu. Ordered by CATEGORY_LABELS' key order in
 *  HelpMenu.tsx, not by this union — but the two are kept in the same
 *  order so reading either one tells you how the menu reads.
 *
 *  "money" and "capture" are groupings of workflow, not of screen.
 *  Clients and expenses are both "the paperwork around a gig" and sit
 *  together; photo capture and email capture are the same feature
 *  reached two ways and belong in one place, which is why
 *  `set-up-email-capture` moved out of "settings" when the photo route
 *  was written. "settings" keeps what is genuinely configuration —
 *  including the calendar connection, whose button happens to live on
 *  the dashboard. */
export type HelpCategory =
  | "getting-started"
  | "gigs"
  | "money"
  | "capture"
  | "settings"
  | "installation";

/** Which install instructions to show. Detection lives in
 *  environment.ts; the type lives here because scenarios reference it. */
export type HelpEnvironment =
  | "ios-safari"
  | "android-chrome"
  | "desktop-chrome"
  | "desktop-edge"
  | "fallback";

export interface HelpScenario {
  id: HelpScenarioId;
  title: string;
  description?: string;
  category: HelpCategory;
  /** Where the scenario begins. The provider routes here before the tour
   *  starts, which is also how "Open Settings" works when help is opened
   *  from Settings — AppHeader hides `settings-link` on that screen. */
  startRoute?: string;
  steps: HelpStep[];
  /** Environment-selected alternatives. Only installation uses these,
   *  and only non-executable scenarios may have them. */
  variants?: HelpVariant[];
  /** Branch ids this scenario is expected to take under the hermetic CI
   *  stack, in order. Asserted by the suite: an environment change that
   *  flips a branch becomes a failure rather than a silent change in
   *  what got tested. */
  expectedCiBranches?: string[];
  /** Set when the scenario cannot execute under Playwright at all —
   *  installation, which lives entirely in browser and OS chrome. */
  executable?: false;
}

/** `NavigateStep` was deliberately absent until `record-work` needed a
 *  tour that outlives the screen it started on. `startRoute` still
 *  covers every scenario that begins and ends in one place; this is for
 *  the one that cannot, because the destination depends on which row
 *  the person taps. */
export type HelpStep =
  | HighlightStep
  | ClickStep
  | InputStep
  | SelectStep
  | NavigateStep
  | BranchStep
  | ExternalInstructionStep;

/** What every step but a branch carries. A `BranchStep` is a fork, not
 *  a thing shown to anyone, so it has no copy of its own and no `end`:
 *  a branch that ends the tour is a branch whose alternatives each end
 *  on a terminal step. */
export interface HelpStepBase {
  title?: string;
  description: string;
  /** The tour ends here. Everything after this step is unreached —
   *  including the steps written after the BRANCH this one sits in,
   *  which is the whole reason the flag exists.
   *
   *  For a path that legitimately cannot continue. `record-work` opens
   *  on the gig list, and two of its three alternatives have no row to
   *  tap; the steps that walk a gig's Work card must not run for them.
   *  `find-a-gig` says exactly this in prose today — "This walkthrough
   *  stops here" — and this makes it something both adapters act on.
   *
   *  `true` rather than `boolean`: `end: false` and no `end` at all are
   *  the same statement, and one way to say a thing is enough. */
  end?: true;
}

export interface HighlightStep extends HelpStepBase {
  action: "highlight";
  target: HelpTarget;
}

export interface ClickStep extends HelpStepBase {
  action: "click";
  target: HelpTarget;
}

export interface InputStep extends HelpStepBase {
  action: "input";
  /** Sample data only — never a real address, name, or token. */
  value?: string;
  target: HelpTarget;
}

export interface SelectStep extends HelpStepBase {
  action: "select";
  value?: string;
  target: HelpTarget;
}

/** The user's own tap takes them to another screen, and the tour
 *  follows them there.
 *
 *  Not "the tour navigates". TourRenderer.ts's governing rule is that
 *  the USER performs the action, and here it is forced as well as
 *  chosen: only their tap knows which gig they meant. What this step
 *  adds is permission — HelpProvider stops treating the route change as
 *  someone walking out on the tour, and TourRenderer stops treating the
 *  target's disappearance as a failure. */
export interface NavigateStep extends HelpStepBase {
  action: "navigate";
  /** What they tap. A CONTAINER of choices, not one control: the tour
   *  spotlights the whole list and the person picks their own row. The
   *  tap advances the step by bubbling to this element, so anything
   *  inside it counts. */
  target: HelpTarget;
  /** The route pattern the tap must land on. A ":param" segment matches
   *  exactly one path segment; nothing else is special. See routes.ts —
   *  the provider adds this to the routes it will tolerate mid-tour,
   *  and the Playwright runner waits for the URL to match it. */
  route: string;
}

/** The app has states that are all legitimate — push available or
 *  explained-as-unavailable, capture configured or not. Help must never
 *  tell someone to click a control that is intentionally absent. */
export interface BranchStep {
  action: "branch";
  /** Ordered. The first branch whose condition holds is taken. None
   *  holding is a failure, not a no-op. */
  branches: HelpBranch[];
}

export interface HelpBranch {
  /** Stable and unique within the scenario. Appears in run traces and in
   *  `expectedCiBranches`, so renaming one is a visible change. */
  id: string;
  when: HelpCondition;
  /** Never contains a nested BranchStep — the validator enforces it. */
  steps: HelpStep[];
}

/** Named and deterministic. Deliberately not an expression language. */
export type HelpCondition =
  | { type: "target-visible"; target: HelpTarget }
  | { type: "target-missing"; target: HelpTarget };

/** Browser and OS operations Gigsy can neither drive nor highlight. */
export interface ExternalInstructionStep extends HelpStepBase {
  action: "external";
  externalType: "browser-ui" | "os-ui";
}

export interface HelpVariant {
  environment: HelpEnvironment;
  /** Shown in the picker, so a wrong guess is recoverable. */
  label: string;
  steps: ExternalInstructionStep[];
}
