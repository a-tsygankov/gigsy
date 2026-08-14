/**
 * The help domain model. Plain data: no DOM access, no Playwright, no
 * React. Every adapter reads this and none of them owns it.
 */
import type { HelpTarget } from "./targets.ts";

export type HelpScenarioId = string;

export type HelpCategory =
  | "getting-started"
  | "gigs"
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

/** No NavigateStep: `startRoute` covers every scenario we have, and
 *  mid-tour navigation would need a renderer that survives a remount.
 *  Add it when something actually needs it. */
export type HelpStep =
  | HighlightStep
  | ClickStep
  | InputStep
  | SelectStep
  | BranchStep
  | ExternalInstructionStep;

export interface HighlightStep {
  action: "highlight";
  target: HelpTarget;
  title?: string;
  description: string;
}

export interface ClickStep {
  action: "click";
  target: HelpTarget;
  title?: string;
  description: string;
}

export interface InputStep {
  action: "input";
  target: HelpTarget;
  /** Sample data only — never a real address, name, or token. */
  value?: string;
  title?: string;
  description: string;
}

export interface SelectStep {
  action: "select";
  target: HelpTarget;
  value?: string;
  title?: string;
  description: string;
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
export interface ExternalInstructionStep {
  action: "external";
  externalType: "browser-ui" | "os-ui";
  title?: string;
  description: string;
}

export interface HelpVariant {
  environment: HelpEnvironment;
  /** Shown in the picker, so a wrong guess is recoverable. */
  label: string;
  steps: ExternalInstructionStep[];
}
