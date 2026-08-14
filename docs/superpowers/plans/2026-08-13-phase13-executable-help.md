# Phase 13: Executable help — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** one machine-readable `HelpScenario` model that drives both an
in-app guided tour and a Playwright suite, so a UI change that breaks a
documented workflow fails CI instead of silently rotting.

**Architecture:** scenario definitions are plain data under
`webapp/src/help/`. Two adapters consume them — a Driver.js tour in the
browser, and a Playwright runner in `webapp/e2e/help/`. Both reach
elements through a shared target model that records *how* a test ID
relates to the thing a person actually touches, because in this codebase
most of them do not match.

**Tech stack:** TypeScript (strict, `exactOptionalPropertyTypes`,
`noUncheckedIndexedAccess`), React 18, React Router 6, Vitest (+ jsdom for
one file), Playwright, Driver.js 1.x, Tailwind.

**Spec:** `docs/gigsy-executable-help-implementation-spec.md`. Read §2
before starting — it holds the nine verified facts that make the obvious
implementation wrong.

---

## The shape

Four PRs. Tasks 1–3 are PR 1, 4–6 are PR 2, 7–10 are PR 3, 11–14 are PR 4.
Screenshot and Markdown generation is PR 5 and deliberately out of scope
(spec §14).

```text
src/help/targets.ts     kind + two resolvers   ─┐
src/help/types.ts       the step union          ├─ PR 1, no UI change
src/help/validate.ts    structural checks       │
src/help/registry.ts    single discovery point ─┘

src/help/runtime/*      provider, menu, tour    ── PR 2, user-visible
e2e/help/*              runner, fixtures, spec  ── PR 3, CI
src/help/scenarios/*    the remaining four      ── PR 4
```

## Decisions, and why

**A target's kind is declared, never inferred.** `Toggle` puts its test ID
on a `peer sr-only` input; the switch you see is a sibling span. Clicking
the tagged input passes a test while proving nothing — `e2e/settings.spec.ts`
says exactly that in the comment above `paintedSwitch`. Name-based
inference gets it backwards twice over: `push-toggle` is a `<Button>` and
`toggle-prefix` is a real switch.

**No `NavigateStep`.** Every MVP scenario starts somewhere and stays
there; `startRoute` covers all five. Mid-tour navigation would require a
state machine in the renderer to survive the remount, and nothing needs
one yet. Add it when a scenario does (spec §3.5).

**Branches are declared and asserted.** A scenario records which branch it
takes under CI in `expectedCiBranches`, and the suite asserts it. Without
that, the notifications scenario would exercise only its dead path forever
and report green — the failure mode `deploy.yml:150` already documents in
this repo.

**Commits.** Each task ends with a commit. Per the standing rule in this
project, the executing agent commits only once the user has said to run
the plan; choosing to execute is that instruction.

---

## Tasks

### Task 1: Target model and resolvers

**Files:**
- Create: `webapp/src/help/targets.ts`
- Create: `webapp/src/help/targets.test.ts`
- Modify: `webapp/package.json` (add `jsdom` devDependency)

- [ ] **Step 1: Add jsdom**

Vitest runs in Node here (`vitest.config.ts` sets only `include`), and
existing tests are pure logic. One DOM test does not justify slowing every
suite, so jsdom is opted into per file.

```bash
pnpm --filter gigsy-webapp add -D jsdom
```

- [ ] **Step 2: Write the failing test**

Create `webapp/src/help/targets.test.ts`:

```ts
/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { HelpTarget, dayToggle, resolveTarget, targetSelector } from "./targets.ts";

/** The markup Toggle actually renders (components/Toggle.tsx): the test
 *  ID sits on a 1x1 sr-only input, and the switch a person can see is a
 *  sibling span inside the wrapping label. */
function renderToggle(testId: string): HTMLElement {
  document.body.innerHTML = `
    <label class="inline-flex h-11 items-center">
      <input type="checkbox" role="switch" class="peer sr-only" data-testid="${testId}" />
      <span aria-hidden="true" class="relative h-6 w-11">
        <span class="absolute left-0.5 top-0.5"></span>
      </span>
    </label>`;
  return document.querySelector("span[aria-hidden='true']")!;
}

describe("resolveTarget", () => {
  it("returns the tagged node for an element target", () => {
    document.body.innerHTML = `<a data-testid="settings-link">Settings</a>`;
    const found = resolveTarget(HelpTarget.SettingsLink);
    expect(found?.tagName).toBe("A");
  });

  it("returns the painted switch, not the sr-only input, for a switch target", () => {
    const paint = renderToggle("toggle-day-0");
    const found = resolveTarget(dayToggle(0));
    expect(found).toBe(paint);
    expect(found?.tagName).toBe("SPAN");
  });

  it("returns null when the target is absent", () => {
    document.body.innerHTML = "";
    expect(resolveTarget(HelpTarget.SettingsLink)).toBeNull();
  });

  it("returns null when a switch target's paint is missing", () => {
    document.body.innerHTML = `<input data-testid="toggle-day-0" />`;
    expect(resolveTarget(dayToggle(0))).toBeNull();
  });
});

describe("targetSelector", () => {
  it("is a plain testid selector for an element target", () => {
    expect(targetSelector(HelpTarget.SettingsLink)).toBe(
      `[data-testid="settings-link"]`,
    );
  });

  // This exact locator is the one e2e/settings.spec.ts already proves
  // correct against the real component. Playwright proves it end to end
  // in Task 9; jsdom's :has() support is not something to depend on.
  it("reaches the paint for a switch target", () => {
    expect(targetSelector(dayToggle(3))).toBe(
      `label:has([data-testid="toggle-day-3"]) span[aria-hidden="true"]`,
    );
  });
});

describe("kinds", () => {
  it("records push-toggle as an element despite its name", () => {
    expect(HelpTarget.PushToggle.kind).toBe("element");
  });

  it("records toggle-prefix as a switch despite being a title prefix", () => {
    expect(HelpTarget.TogglePrefix.kind).toBe("switch");
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

```bash
pnpm --filter gigsy-webapp test src/help/targets.test.ts
```

Expected: FAIL — `Cannot find module './targets.ts'`.

- [ ] **Step 4: Implement**

Create `webapp/src/help/targets.ts`:

```ts
/**
 * What help scenarios point at, and the one fact that makes them work:
 * how an element's test ID relates to the thing a person touches.
 *
 * Most interactive controls here are `Toggle`, which puts its test ID on
 * a `peer sr-only` input — one pixel square — while the switch you can
 * see is a sibling span. Highlighting the tagged node spotlights nothing,
 * and clicking it in a test passes while proving nothing a user could do.
 * The comment above `paintedSwitch` in e2e/settings.spec.ts is the same
 * lesson learned the expensive way.
 *
 * So kind is DECLARED, never derived from the name. The name lies in both
 * directions: `push-toggle` is a Button, and `toggle-prefix` is a switch
 * for a calendar title prefix.
 */

export type HelpTargetKind = "element" | "switch";

export interface HelpTarget {
  readonly id: string;
  readonly kind: HelpTargetKind;
}

const element = (id: string): HelpTarget => ({ id, kind: "element" });
const painted = (id: string): HelpTarget => ({ id, kind: "switch" });

/** Deliberately shares its name with the interface above — one is a type,
 *  the other a value, and `HelpTarget.SettingsLink` is how call sites
 *  want to read. */
export const HelpTarget = {
  SettingsLink: element("settings-link"),
  SettingsHelp: element("settings-help"),

  SettingsNotifications: element("settings-notifications"),
  // A <Button>, not a Toggle, despite the name — Settings.tsx:108.
  PushToggle: element("push-toggle"),
  PushUnavailable: element("push-unavailable"),

  SettingsCapture: element("settings-capture"),
  CaptureAddress: element("capture-address"),
  CaptureAddressValue: element("capture-address-value"),
  CaptureUnconfigured: element("capture-unconfigured"),

  SettingsAvailability: element("settings-availability"),
  AvailWorkingWeek: element("avail-working-week"),

  // A calendar *title prefix* switch — nothing to do with toggle naming.
  TogglePrefix: painted("toggle-prefix"),
} as const;

export type WeekdayIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** Working-hours day switches are generated per weekday, so the target
 *  is too. AvailabilitySection.tsx renders `toggle-day-${index}`. */
export const dayToggle = (i: WeekdayIndex): HelpTarget =>
  painted(`toggle-day-${i}`);

/** The start-time select on a working-hours row. An `element`: Select
 *  renders a real <select> carrying the test ID. */
export const dayStart = (i: WeekdayIndex): HelpTarget =>
  element(`start-day-${i}`);

/** CSS for Playwright. Exactly the locator e2e/settings.spec.ts proves
 *  against the real component. */
export function targetSelector(t: HelpTarget): string {
  return t.kind === "switch"
    ? `label:has([data-testid="${t.id}"]) span[aria-hidden="true"]`
    : `[data-testid="${t.id}"]`;
}

/** DOM for the tour. Walks rather than using `:has()`, so the spotlight
 *  never depends on selector support in an older mobile Safari. */
export function resolveTarget(t: HelpTarget): HTMLElement | null {
  const tagged = document.querySelector<HTMLElement>(
    `[data-testid="${CSS.escape(t.id)}"]`,
  );
  if (tagged === null) return null;
  if (t.kind === "element") return tagged;
  return (
    tagged
      .closest("label")
      ?.querySelector<HTMLElement>('span[aria-hidden="true"]') ?? null
  );
}
```

- [ ] **Step 5: Run and confirm it passes**

```bash
pnpm --filter gigsy-webapp test src/help/targets.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add webapp/src/help/targets.ts webapp/src/help/targets.test.ts webapp/package.json pnpm-lock.yaml
git commit -m "feat(help): target model recording how a test ID reaches its control"
```

---

### Task 2: Scenario types and validator

**Files:**
- Create: `webapp/src/help/types.ts`
- Create: `webapp/src/help/validate.ts`
- Create: `webapp/src/help/validate.test.ts`

- [ ] **Step 1: Write the types**

Create `webapp/src/help/types.ts`:

```ts
/**
 * The help domain model. Plain data: no DOM access, no Playwright, no
 * React. Every adapter reads this and none of them owns it.
 */
import type { HelpTarget } from "./targets.ts";

export type HelpScenarioId = string;

export type HelpCategory = "getting-started" | "settings" | "installation";

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
```

- [ ] **Step 2: Write the failing validator test**

Create `webapp/src/help/validate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { HelpTarget } from "./targets.ts";
import { validateHelpRegistry } from "./validate.ts";
import type { HelpScenario } from "./types.ts";

const ok: HelpScenario = {
  id: "ok",
  title: "Fine",
  category: "settings",
  steps: [
    {
      action: "highlight",
      target: HelpTarget.SettingsNotifications,
      description: "Here it is.",
    },
  ],
};

const messages = (scenarios: HelpScenario[]): string[] =>
  validateHelpRegistry(scenarios).map((p) => p.message);

describe("validateHelpRegistry", () => {
  it("passes a well-formed scenario", () => {
    expect(validateHelpRegistry([ok])).toEqual([]);
  });

  it("catches a duplicate scenario id", () => {
    expect(messages([ok, { ...ok }])).toContain("duplicate scenario id");
  });

  it("catches a scenario with nothing in it", () => {
    expect(messages([{ ...ok, steps: [] }])).toContain(
      "scenario has neither steps nor variants",
    );
  });

  it("catches a duplicate branch id", () => {
    const scenario: HelpScenario = {
      ...ok,
      steps: [
        {
          action: "branch",
          branches: [
            {
              id: "same",
              when: { type: "target-visible", target: HelpTarget.PushToggle },
              steps: [ok.steps[0]!],
            },
            {
              id: "same",
              when: { type: "target-missing", target: HelpTarget.PushToggle },
              steps: [ok.steps[0]!],
            },
          ],
        },
      ],
    };
    expect(messages([scenario])).toContain(`duplicate branch id "same"`);
  });

  it("catches a branch nested inside a branch", () => {
    const scenario: HelpScenario = {
      ...ok,
      steps: [
        {
          action: "branch",
          branches: [
            {
              id: "outer",
              when: { type: "target-visible", target: HelpTarget.PushToggle },
              steps: [{ action: "branch", branches: [] }],
            },
          ],
        },
      ],
    };
    expect(messages([scenario])).toContain(
      `branch "outer" nests another branch step`,
    );
  });

  it("catches an external step with no description", () => {
    const scenario: HelpScenario = {
      ...ok,
      executable: false,
      steps: [{ action: "external", externalType: "os-ui", description: "  " }],
    };
    expect(messages([scenario])).toContain(
      "external step has an empty description",
    );
  });

  it("catches expectedCiBranches naming a branch that does not exist", () => {
    expect(messages([{ ...ok, expectedCiBranches: ["ghost"] }])).toContain(
      `expectedCiBranches names "ghost", which is not a branch in this scenario`,
    );
  });

  it("catches an executable scenario whose every step is external", () => {
    const scenario: HelpScenario = {
      ...ok,
      steps: [
        { action: "external", externalType: "os-ui", description: "Tap Share." },
      ],
    };
    expect(messages([scenario])).toContain(
      "scenario is executable but every step is external",
    );
  });

  it("catches variants on an executable scenario", () => {
    const scenario: HelpScenario = {
      ...ok,
      variants: [
        {
          environment: "fallback",
          label: "Any browser",
          steps: [
            { action: "external", externalType: "browser-ui", description: "x" },
          ],
        },
      ],
    };
    expect(messages([scenario])).toContain(
      "variants are only supported on non-executable scenarios",
    );
  });

  it("catches duplicate variant environments and a missing fallback", () => {
    const variant = {
      environment: "ios-safari" as const,
      label: "iPhone",
      steps: [
        {
          action: "external" as const,
          externalType: "os-ui" as const,
          description: "Tap Share.",
        },
      ],
    };
    const scenario: HelpScenario = {
      ...ok,
      executable: false,
      steps: [],
      variants: [variant, { ...variant, label: "iPhone again" }],
    };
    const found = messages([scenario]);
    expect(found).toContain(`duplicate variant environment "ios-safari"`);
    expect(found).toContain("no fallback variant");
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

```bash
pnpm --filter gigsy-webapp test src/help/validate.test.ts
```

Expected: FAIL — `Cannot find module './validate.ts'`.

- [ ] **Step 4: Implement the validator**

Create `webapp/src/help/validate.ts`:

```ts
/**
 * Structural checks that need no browser. Whether a target still exists
 * in the DOM is not a static question — that is what the Playwright
 * suite is for. An *unknown* target cannot happen at all: steps hold
 * HelpTarget objects, so TypeScript rejects one that does not exist.
 */
import type { HelpScenario, HelpStep } from "./types.ts";

export interface HelpProblem {
  scenarioId: string;
  message: string;
}

function everyStepExternal(steps: HelpStep[]): boolean {
  return steps.every((step) =>
    step.action === "external"
      ? true
      : step.action === "branch"
        ? step.branches.every((b) => everyStepExternal(b.steps))
        : false,
  );
}

export function validateHelpRegistry(scenarios: HelpScenario[]): HelpProblem[] {
  const problems: HelpProblem[] = [];
  const seenScenarios = new Set<string>();

  for (const scenario of scenarios) {
    const report = (message: string): void => {
      problems.push({ scenarioId: scenario.id, message });
    };

    if (seenScenarios.has(scenario.id)) report("duplicate scenario id");
    seenScenarios.add(scenario.id);

    const variants = scenario.variants ?? [];
    const executable = scenario.executable !== false;

    if (scenario.steps.length === 0 && variants.length === 0) {
      report("scenario has neither steps nor variants");
    }

    const branchIds = new Set<string>();
    const checkExternal = (step: HelpStep, where: string): void => {
      if (step.action === "external" && step.description.trim() === "") {
        report(
          where === ""
            ? "external step has an empty description"
            : `${where} has an external step with an empty description`,
        );
      }
    };

    for (const step of scenario.steps) {
      checkExternal(step, "");
      if (step.action !== "branch") continue;

      if (step.branches.length === 0) report("branch step has no branches");
      for (const branch of step.branches) {
        if (branchIds.has(branch.id)) {
          report(`duplicate branch id "${branch.id}"`);
        }
        branchIds.add(branch.id);

        if (branch.steps.length === 0) {
          report(`branch "${branch.id}" has no steps`);
        }
        if (branch.steps.some((s) => s.action === "branch")) {
          report(`branch "${branch.id}" nests another branch step`);
        }
        for (const inner of branch.steps) {
          checkExternal(inner, `branch "${branch.id}"`);
        }
      }
    }

    for (const id of scenario.expectedCiBranches ?? []) {
      if (!branchIds.has(id)) {
        report(
          `expectedCiBranches names "${id}", which is not a branch in this scenario`,
        );
      }
    }

    if (scenario.steps.length > 0) {
      const allExternal = everyStepExternal(scenario.steps);
      if (executable && allExternal) {
        report("scenario is executable but every step is external");
      }
      if (!executable && !allExternal) {
        report("scenario is marked non-executable but contains executable steps");
      }
    }

    if (variants.length > 0) {
      if (executable) {
        report("variants are only supported on non-executable scenarios");
      }
      const seenEnvironments = new Set<string>();
      for (const variant of variants) {
        if (seenEnvironments.has(variant.environment)) {
          report(`duplicate variant environment "${variant.environment}"`);
        }
        seenEnvironments.add(variant.environment);
        if (variant.steps.length === 0) {
          report(`variant "${variant.environment}" has no steps`);
        }
        for (const step of variant.steps) {
          checkExternal(step, `variant "${variant.environment}"`);
        }
      }
      // A wrong user-agent guess must never leave someone with nothing.
      if (!seenEnvironments.has("fallback")) report("no fallback variant");
    }
  }

  return problems;
}
```

- [ ] **Step 5: Run and confirm it passes**

```bash
pnpm --filter gigsy-webapp test src/help/validate.test.ts
```

Expected: PASS, 10 tests.

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm --filter gigsy-webapp typecheck
git add webapp/src/help/types.ts webapp/src/help/validate.ts webapp/src/help/validate.test.ts
git commit -m "feat(help): scenario model and browser-free validator"
```

---

### Task 3: Registry and the first scenario

**Files:**
- Create: `webapp/src/help/scenarios/open-settings.ts`
- Create: `webapp/src/help/registry.ts`
- Create: `webapp/src/help/registry.test.ts`

- [ ] **Step 1: Write the failing test**

Create `webapp/src/help/registry.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  executableHelpScenarios,
  getHelpScenario,
  helpScenarios,
} from "./registry.ts";
import { validateHelpRegistry } from "./validate.ts";

describe("the help registry", () => {
  it("is structurally valid", () => {
    expect(validateHelpRegistry(helpScenarios)).toEqual([]);
  });

  it("finds a scenario by id", () => {
    expect(getHelpScenario("open-settings")?.title).toBe("Open Settings");
  });

  it("returns undefined for an unknown id", () => {
    expect(getHelpScenario("nope")).toBeUndefined();
  });

  it("lists every scenario as executable until one opts out", () => {
    expect(executableHelpScenarios.length).toBe(helpScenarios.length);
  });

  // Opening help from Settings and being told to tap a link that
  // AppHeader hides on that very screen is the trap startRoute exists
  // to avoid (AppHeader.tsx:43).
  it("starts the settings-link scenario somewhere that renders it", () => {
    expect(getHelpScenario("open-settings")?.startRoute).toBe("/");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
pnpm --filter gigsy-webapp test src/help/registry.test.ts
```

Expected: FAIL — `Cannot find module './registry.ts'`.

- [ ] **Step 3: Write the scenario**

Create `webapp/src/help/scenarios/open-settings.ts`:

```ts
import { HelpTarget } from "../targets.ts";
import type { HelpScenario } from "../types.ts";

/** The simplest thing that proves model, tour and runner agree. */
export const openSettings: HelpScenario = {
  id: "open-settings",
  title: "Open Settings",
  description: "Everything you can configure lives on one screen.",
  category: "settings",
  // Not "/settings": AppHeader hides the link on the screen it leads to,
  // so a tour starting there would point at nothing.
  startRoute: "/",
  steps: [
    {
      action: "click",
      target: HelpTarget.SettingsLink,
      title: "Open Settings",
      description: "Tap Settings, at the top right of any screen.",
    },
  ],
};
```

- [ ] **Step 4: Write the registry**

Create `webapp/src/help/registry.ts`:

```ts
/**
 * The single discovery mechanism — the help menu, the Playwright suite
 * and any future generator all read this and nothing else.
 */
import { openSettings } from "./scenarios/open-settings.ts";
import type { HelpScenario, HelpScenarioId } from "./types.ts";

export const helpScenarios: HelpScenario[] = [openSettings];

export function getHelpScenario(
  id: HelpScenarioId,
): HelpScenario | undefined {
  return helpScenarios.find((scenario) => scenario.id === id);
}

/** Installation lives in browser and OS chrome, so it is described but
 *  never executed. */
export const executableHelpScenarios: HelpScenario[] = helpScenarios.filter(
  (scenario) => scenario.executable !== false,
);
```

- [ ] **Step 5: Run the whole unit suite**

```bash
pnpm --filter gigsy-webapp test && pnpm --filter gigsy-webapp typecheck
```

Expected: PASS. No existing test changes behaviour — nothing imports
`src/help` yet.

- [ ] **Step 6: Confirm no user-visible change, then commit**

```bash
pnpm --filter gigsy-webapp build
git add webapp/src/help/
git commit -m "feat(help): scenario registry and the open-settings scenario"
```

**PR 1 is complete here.** `pnpm typecheck && pnpm test && pnpm test:e2e`
must all be green, and the app is byte-for-byte unchanged in behaviour.

---

### Task 4: HelpProvider

**Files:**
- Create: `webapp/src/help/runtime/HelpProvider.tsx`
- Modify: `webapp/src/App.tsx:26-27` (wrap in the provider)

- [ ] **Step 1: Write the provider**

Follows `ConsoleProvider` (`src/components/ConsoleProvider.tsx`) — the
established context pattern in this codebase. It must live inside
`BrowserRouter`, which `App.tsx` already is (`main.tsx:36`), so
`useNavigate` works.

Create `webapp/src/help/runtime/HelpProvider.tsx`:

```tsx
/**
 * Owns "which scenario is running". Routing to a scenario's startRoute
 * happens here rather than in the renderer, because the tour has to be
 * built against the DOM it will highlight — starting a tour and then
 * navigating would spotlight elements that are about to unmount.
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { appLog } from "../../lib/logger.ts";
import { getHelpScenario } from "../registry.ts";
import type { HelpScenarioId } from "../types.ts";

interface HelpContextValue {
  isOpen: boolean;
  openHelp(): void;
  closeHelp(): void;
  startScenario(id: HelpScenarioId): Promise<void>;
  /** Set when a scenario ended early — a missing target, or no branch
   *  matching. Rendered by the menu; never thrown into the app. */
  unavailable: string | null;
  dismissUnavailable(): void;
}

const HelpContext = createContext<HelpContextValue | null>(null);

export function useHelp(): HelpContextValue {
  const value = useContext(HelpContext);
  if (value === null) throw new Error("useHelp outside HelpProvider");
  return value;
}

/** Waits for the router to settle on `route` before the tour is built.
 *  Polling beats a timeout: it finishes as soon as it is true. */
async function waitForRoute(route: string, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (window.location.pathname === route) return true;
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  return false;
}

export function HelpProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const cancelRef = useRef<(() => void) | null>(null);

  const closeHelp = useCallback(() => {
    cancelRef.current?.();
    cancelRef.current = null;
    setIsOpen(false);
  }, []);

  const startScenario = useCallback(
    async (id: HelpScenarioId): Promise<void> => {
      const scenario = getHelpScenario(id);
      if (scenario === undefined) {
        setUnavailable("That help topic no longer exists.");
        return;
      }

      setIsOpen(false);

      if (
        scenario.startRoute !== undefined &&
        location.pathname !== scenario.startRoute
      ) {
        navigate(scenario.startRoute);
        if (!(await waitForRoute(scenario.startRoute))) {
          appLog.warn("help: startRoute never settled", { id });
          setUnavailable("This help step is currently unavailable.");
          return;
        }
      }

      // Loaded on demand: Driver.js and its CSS have no business in the
      // initial bundle (spec §12).
      const { runTour } = await import("./TourRenderer.ts");
      cancelRef.current = await runTour(scenario, {
        onUnavailable: (reason) => {
          appLog.warn("help: scenario ended early", { id, reason });
          setUnavailable("This help step is currently unavailable.");
        },
      });
    },
    [location.pathname, navigate],
  );

  const value = useMemo<HelpContextValue>(
    () => ({
      isOpen,
      openHelp: () => {
        setUnavailable(null);
        setIsOpen(true);
      },
      closeHelp,
      startScenario,
      unavailable,
      dismissUnavailable: () => setUnavailable(null),
    }),
    [isOpen, closeHelp, startScenario, unavailable],
  );

  return <HelpContext.Provider value={value}>{children}</HelpContext.Provider>;
}
```

- [ ] **Step 2: Mount it**

Modify `webapp/src/App.tsx`. Inside `ConsoleProvider`, wrapping `UpdateBar`
and `Routes`:

```tsx
import { HelpProvider } from "./help/runtime/HelpProvider.tsx";
```

```tsx
    <ConsoleProvider>
      <HelpProvider>
        {/* Above the routes: a stale bundle is stale on every
            screen, including login and the public page. */}
        <UpdateBar />
        <Routes>
          {/* …unchanged… */}
        </Routes>
      </HelpProvider>
    </ConsoleProvider>
```

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter gigsy-webapp typecheck
```

Expected: FAIL — `./TourRenderer.ts` does not exist yet. That is the next
task; do not stub it.

- [ ] **Step 4: Commit after Task 5**

The provider does not compile without the renderer. Both land in one
commit at the end of Task 5.

---

### Task 5: TourRenderer

**Files:**
- Create: `webapp/src/help/runtime/TourRenderer.ts`
- Create: `webapp/src/styles/help.css`
- Modify: `webapp/src/styles.css` (import the help styles)
- Modify: `webapp/package.json` (add `driver.js`)

- [ ] **Step 1: Add Driver.js**

```bash
pnpm --filter gigsy-webapp add driver.js
```

- [ ] **Step 2: Write the renderer**

Driver.js 1.x API, as documented: `driver({ steps, popoverClass, ... })`,
`DriveStep.element` accepts an `Element`, `driverObj.drive()`,
`.moveNext()`, `.destroy()`, `popover.showButtons: ["next","previous","close"]`.

Create `webapp/src/help/runtime/TourRenderer.ts`:

```ts
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
  HelpCondition,
  HelpScenario,
  HelpStep,
} from "../types.ts";

interface TourOptions {
  onUnavailable(reason: string): void;
}

/** Cancels the tour. */
export type CancelTour = () => void;

function conditionHolds(condition: HelpCondition): boolean {
  const found = resolveTarget(condition.target);
  const visible = found !== null && found.getBoundingClientRect().height > 0;
  return condition.type === "target-visible" ? visible : !visible;
}

/** Waits until one of the branch conditions holds. Data arrives through
 *  react-query, so neither branch is resolvable on the first frame. */
async function settleBranch(
  step: Extract<HelpStep, { action: "branch" }>,
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
 *  by the time Driver.js sees it. */
async function flatten(steps: HelpStep[]): Promise<HelpStep[] | null> {
  const flat: HelpStep[] = [];
  for (const step of steps) {
    if (step.action !== "branch") {
      flat.push(step);
      continue;
    }
    const taken = await settleBranch(step);
    if (taken === null) return null;
    flat.push(...taken);
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

  const cleanups: Array<() => void> = [];
  const driveSteps = [];

  for (const step of flat) {
    if (step.action === "external") {
      driveSteps.push({
        popover: {
          title: step.title ?? scenario.title,
          description: step.description,
          showButtons: ["next", "previous", "close"] as const,
        },
      });
      continue;
    }

    const el = resolveTarget(step.target);
    if (el === null) {
      options.onUnavailable(`target ${step.target.id} not found`);
      return () => undefined;
    }

    driveSteps.push({
      element: el,
      popover: {
        title: step.title ?? scenario.title,
        description: step.description,
        // A click step advances by being done, not by pressing Next.
        showButtons: (step.action === "click"
          ? ["close"]
          : ["next", "previous", "close"]) as string[],
      },
    });
  }

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

  // Advance on the real interaction, once per click step.
  flat.forEach((step, index) => {
    if (step.action !== "click") return;
    const el = resolveTarget(step.target);
    if (el === null) return;
    const onClick = (): void => {
      if (index === flat.length - 1) tour.destroy();
      else tour.moveNext();
    };
    el.addEventListener("click", onClick, { once: true });
    cleanups.push(() => el.removeEventListener("click", onClick));
  });

  tour.drive();

  return () => {
    tour.destroy();
  };
}
```

- [ ] **Step 3: Restyle the popover**

`docs/design-system.md` allows no third-party visual language. Create
`webapp/src/styles/help.css`:

```css
/* Driver.js ships its own popover look. Gigsy has one surface style and
   one button style (docs/design-system.md); an unrestyled popover reads
   as another product's UI dropped onto the screen. Tokens mirror Card
   and Button rather than repeating hex values by eye. */
.gigsy-help-popover.driver-popover {
  background-color: #ffffff;
  border: 1px solid rgb(226 232 240); /* slate-200, as Card */
  border-radius: 1rem; /* rounded-2xl */
  box-shadow: 0 1px 2px 0 rgb(0 0 0 / 0.05);
  color: rgb(15 23 42); /* slate-900 */
  font-family: inherit; /* the system stack; Gigsy ships no webfont */
  max-width: 20rem;
}

.gigsy-help-popover .driver-popover-title {
  font-size: 0.875rem;
  font-weight: 600;
  color: rgb(15 23 42);
}

.gigsy-help-popover .driver-popover-description {
  font-size: 0.75rem;
  line-height: 1.625;
  color: rgb(100 116 139); /* slate-500 */
}

.gigsy-help-popover .driver-popover-navigation-btns button {
  background-color: rgb(236 253 245); /* emerald-50, as Button soft */
  color: rgb(4 120 87); /* emerald-700 */
  border: none;
  border-radius: 0.75rem;
  padding: 0.5rem 0.75rem;
  font-size: 0.875rem;
  font-weight: 500;
  text-shadow: none;
}

.gigsy-help-popover .driver-popover-navigation-btns button:focus-visible {
  outline: 2px solid rgb(16 185 129); /* emerald-500 */
  outline-offset: 2px;
}

.gigsy-help-popover .driver-popover-progress-text {
  font-size: 0.75rem;
  color: rgb(148 163 184); /* slate-400 */
}

.gigsy-help-popover .driver-popover-arrow {
  border-color: #ffffff;
}

/* The spotlight must not rely on colour alone (spec §7.5): the cutout
   itself carries the meaning, and the ring reinforces it. */
.driver-active-element {
  outline: 2px solid rgb(16 185 129);
  outline-offset: 2px;
  border-radius: 0.5rem;
}
```

Add to `webapp/src/styles.css`, after the Tailwind directives:

```css
@import "./styles/help.css";
```

- [ ] **Step 4: Typecheck and build**

```bash
pnpm --filter gigsy-webapp typecheck && pnpm --filter gigsy-webapp build
```

Expected: PASS. If `driver.js/dist/driver.css` fails to typecheck as a
module import, add to `webapp/src/vite-env.d.ts` (create it if absent):

```ts
declare module "*.css";
```

- [ ] **Step 5: Verify Driver.js is not in the initial bundle**

```bash
grep -rl "driver" webapp/dist/assets/*.js | head
```

Expected: the match appears only in a lazily-loaded chunk, never in the
entry chunk named in `webapp/dist/index.html`. If it is in the entry,
the `import()` has been hoisted — check that nothing imports
`TourRenderer.ts` statically.

- [ ] **Step 6: Commit**

```bash
git add webapp/src/help/runtime/ webapp/src/styles/help.css webapp/src/styles.css webapp/src/App.tsx webapp/package.json pnpm-lock.yaml
git commit -m "feat(help): guided tour renderer over Driver.js, restyled to the design system"
```

---

### Task 6: The launcher on Settings

**Files:**
- Create: `webapp/src/help/runtime/HelpMenu.tsx`
- Create: `webapp/src/help/runtime/HelpSection.tsx`
- Create: `webapp/src/help/scenarios/notifications.ts`
- Modify: `webapp/src/help/registry.ts`
- Modify: `webapp/src/screens/Settings.tsx:237` (insert above Account)

- [ ] **Step 1: Write the menu**

`HelpMenu` owns the list; `HelpSection` owns placement. The split is what
makes a header entry point additive later rather than a duplicate.

Create `webapp/src/help/runtime/HelpMenu.tsx`:

```tsx
/**
 * The list of help topics. Semantic buttons and a real text input, so
 * the whole thing works from a keyboard (spec §7.5).
 */
import { useMemo, useState } from "react";
import { Button, Input } from "../../components/index.ts";
import { helpScenarios } from "../registry.ts";
import type { HelpCategory, HelpScenario } from "../types.ts";
import { useHelp } from "./HelpProvider.tsx";

const CATEGORY_LABELS: Record<HelpCategory, string> = {
  "getting-started": "Getting started",
  settings: "Settings",
  installation: "Installing Gigsy",
};

function matches(scenario: HelpScenario, query: string): boolean {
  if (query === "") return true;
  const haystack = `${scenario.title} ${scenario.description ?? ""}`;
  return haystack.toLowerCase().includes(query.toLowerCase());
}

export function HelpMenu() {
  const { startScenario, unavailable, dismissUnavailable } = useHelp();
  const [query, setQuery] = useState("");

  const grouped = useMemo(() => {
    const found = helpScenarios.filter((s) => matches(s, query.trim()));
    const categories = [...new Set(found.map((s) => s.category))];
    return categories.map((category) => ({
      category,
      scenarios: found.filter((s) => s.category === category),
    }));
  }, [query]);

  return (
    <div className="space-y-3 py-3">
      {unavailable !== null && (
        <div
          className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800"
          role="status"
          data-testid="help-unavailable"
        >
          {unavailable}{" "}
          <button
            type="button"
            className="font-medium underline"
            onClick={dismissUnavailable}
          >
            Dismiss
          </button>
        </div>
      )}

      <Input
        type="search"
        value={query}
        aria-label="Search help topics"
        placeholder="Search help"
        data-testid="help-search"
        onChange={(e) => setQuery(e.target.value)}
      />

      {grouped.length === 0 && (
        <p className="text-xs text-slate-500">No help topic matches that.</p>
      )}

      {grouped.map(({ category, scenarios }) => (
        <div key={category} className="space-y-1">
          <p className="text-xs font-semibold text-slate-500">
            {CATEGORY_LABELS[category]}
          </p>
          {scenarios.map((scenario) => (
            <Button
              key={scenario.id}
              variant="ghost"
              // `block`, not a justify override: Button's base class sets
              // justify-center, and two equal-specificity Tailwind
              // utilities would be decided by stylesheet order.
              block
              data-testid={`help-start-${scenario.id}`}
              onClick={() => void startScenario(scenario.id)}
            >
              {scenario.title}
            </Button>
          ))}
        </div>
      ))}
    </div>
  );
}
```

`Button` accepts `variant`, `size`, `block`, `className` and every native
button prop (`src/components/Button.tsx`). Use the variants it offers
rather than adding a new one — this is a list of text actions.

- [ ] **Step 2: Write the section**

Create `webapp/src/help/runtime/HelpSection.tsx`:

```tsx
/**
 * Where help lives: a Settings group, not a header button. At 375px the
 * header already carries wordmark, title, sync chip and the Settings
 * link, the tab bar is at its five-tab limit, and Gigsy has no icon set
 * to shrink an entry point into (docs/design-system.md).
 */
import { SettingGroup } from "../../components/index.ts";
import { HelpMenu } from "./HelpMenu.tsx";

export function HelpSection() {
  return (
    <SettingGroup
      title="Help"
      description="Step-by-step walkthroughs over the real screens."
      data-testid="settings-help"
    >
      <HelpMenu />
    </SettingGroup>
  );
}
```

- [ ] **Step 3: Mount it on Settings**

Modify `webapp/src/screens/Settings.tsx`. Import:

```tsx
import { HelpSection } from "../help/runtime/HelpSection.tsx";
```

and insert above the Account heading (currently line 237):

```tsx
        <SectionHeading>Help</SectionHeading>
        <HelpSection />

        <SectionHeading>Account</SectionHeading>
```

- [ ] **Step 4: Write the notifications scenario**

Create `webapp/src/help/scenarios/notifications.ts`:

```ts
import { HelpTarget } from "../targets.ts";
import type { HelpScenario } from "../types.ts";

/**
 * The conditional case. Push is genuinely unavailable on plenty of real
 * devices — iOS before the app is installed, a blocked permission, a
 * deployment with no VAPID keys — and Settings.tsx renders either the
 * button or an explanation, never both. Telling someone to tap a control
 * that is deliberately absent is worse than saying nothing.
 */
export const configureNotifications: HelpScenario = {
  id: "configure-notifications",
  title: "Turn on notifications",
  description:
    "A nudge when a lead goes cold or an invoice stays unpaid.",
  category: "settings",
  startRoute: "/settings",
  // Headless Chromium cannot grant notification permission and the local
  // worker has no push config, so CI always takes the blocked branch.
  // Saying so here is the point: if that ever changes, the suite fails
  // instead of quietly testing something else.
  expectedCiBranches: ["push-blocked"],
  steps: [
    {
      action: "highlight",
      target: HelpTarget.SettingsNotifications,
      title: "Notifications",
      description:
        "Reminders live here. At most one a day, and only for work that needs chasing.",
    },
    {
      action: "branch",
      branches: [
        {
          id: "push-available",
          when: { type: "target-visible", target: HelpTarget.PushToggle },
          steps: [
            {
              action: "click",
              target: HelpTarget.PushToggle,
              title: "Turn them on",
              description:
                "Tap this, then allow notifications when your browser asks.",
            },
          ],
        },
        {
          id: "push-blocked",
          when: { type: "target-visible", target: HelpTarget.PushUnavailable },
          steps: [
            {
              action: "highlight",
              target: HelpTarget.PushUnavailable,
              title: "Not available here",
              description:
                "This message says why, and what to do about it — usually installing Gigsy to your home screen first.",
            },
          ],
        },
      ],
    },
  ],
};
```

- [ ] **Step 5: Register it**

Modify `webapp/src/help/registry.ts`:

```ts
import { configureNotifications } from "./scenarios/notifications.ts";
import { openSettings } from "./scenarios/open-settings.ts";

export const helpScenarios: HelpScenario[] = [
  openSettings,
  configureNotifications,
];
```

- [ ] **Step 6: Run the unit suite**

```bash
pnpm --filter gigsy-webapp test && pnpm --filter gigsy-webapp typecheck
```

Expected: PASS. `registry.test.ts` re-validates the registry, so a
malformed branch fails here.

- [ ] **Step 7: Verify by hand in the running app**

```bash
pnpm --filter gigsy-webapp dev
```

Check all of these, because none is covered by a test yet:

1. Settings shows a Help group listing both topics.
2. "Open Settings" navigates to `/` first, then spotlights the header
   Settings link — starting from `/settings` included.
3. Tapping the highlighted link advances/ends the tour.
4. "Turn on notifications" highlights the notifications card, then either
   the button or the explanation — whichever the browser produces.
5. Escape closes the tour and leaves the app usable.
6. Tab reaches the search box and every topic button.
7. The popover looks like Gigsy, not like Driver.js.

- [ ] **Step 8: Confirm existing E2E still passes**

```bash
E2E_BASE_URL=http://127.0.0.1:5173 pnpm --filter gigsy-webapp test:e2e
```

Expected: PASS, unchanged count. The Settings screen gained a section;
nothing existing asserts on its section count, but confirm rather than
assume.

- [ ] **Step 9: Commit**

```bash
git add webapp/src/help/ webapp/src/screens/Settings.tsx
git commit -m "feat(help): help section on Settings with the notifications walkthrough"
```

**PR 2 is complete here.**

---

### Task 7: Type-check the e2e directory

**Files:**
- Create: `webapp/tsconfig.e2e.json`
- Modify: `webapp/tsconfig.json`

This is groundwork for Task 8: without it, the runner's use of the shared
model is unchecked and the "one typed model" claim is false.

- [ ] **Step 1: Add the project**

Create `webapp/tsconfig.e2e.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["e2e"]
}
```

- [ ] **Step 2: Reference it**

Modify `webapp/tsconfig.json`:

```json
{
  "files": [],
  "references": [
    { "path": "./tsconfig.app.json" },
    { "path": "./tsconfig.node.json" },
    { "path": "./tsconfig.e2e.json" }
  ]
}
```

- [ ] **Step 3: Run and fix what surfaces**

```bash
pnpm --filter gigsy-webapp typecheck
```

Nothing has ever type-checked `e2e/`, so expect pre-existing errors. Fix
them properly — do not loosen the config to make them go away. Likely
candidates given the settings on `tsconfig.app.json`:
`noUncheckedIndexedAccess` on array access, and `baseURL!` non-null
assertions that are already present and fine.

- [ ] **Step 4: Commit**

```bash
git add webapp/tsconfig.json webapp/tsconfig.e2e.json webapp/e2e/
git commit -m "build: type-check the e2e directory"
```

---

### Task 8: The Playwright runner

**Files:**
- Create: `webapp/e2e/help/help-runner.ts`
- Create: `webapp/e2e/help/help-fixtures.ts`

- [ ] **Step 1: Write the fixtures**

Reuses the repository's existing test auth rather than inventing a
second mechanism.

Create `webapp/e2e/help/help-fixtures.ts`:

```ts
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { requireTestAuth } from "../helpers/test-auth.ts";
import type { HelpScenario } from "../../src/help/types.ts";

/**
 * Help scenarios toggle working days, which is a write. The config's
 * default baseURL is the production deployment, and its comment says the
 * suite shares the production D1 — running there would corrupt real
 * settings rather than test them.
 */
export function requireLocalTarget(): void {
  const target = process.env["E2E_BASE_URL"];
  if (target === undefined || target === "") {
    throw new Error(
      "help:test requires E2E_BASE_URL pointing at a local stack (see the " +
        "webapp-e2e-full job in .github/workflows/deploy.yml). It must " +
        "never run against the production deployment.",
    );
  }
  if (/pages\.dev/.test(target)) {
    throw new Error(
      `help:test refuses to run against ${target}: these scenarios write ` +
        "settings, and that deployment shares the production database.",
    );
  }
}

/** Sign in and land on the scenario's starting screen. */
export async function prepareHelpScenario(
  page: Page,
  request: APIRequestContext,
  baseURL: string,
  scenario: HelpScenario,
): Promise<void> {
  await requireTestAuth(request, baseURL);
  await page.goto("/login");
  await page.getByTestId("test-signin").click();
  await expect(page.getByTestId("tab-bar")).toBeVisible();

  if (scenario.startRoute !== undefined) {
    await page.goto(scenario.startRoute);
  }
}
```

- [ ] **Step 2: Write the runner**

Create `webapp/e2e/help/help-runner.ts`:

```ts
/**
 * Executes a HelpScenario. Unlike the in-app tour, which instructs and
 * waits, this performs the actions itself — that is the whole point:
 * proving the documented workflow is still doable.
 *
 * Every locator goes through targetSelector, so a `switch` target
 * resolves to the painted span. Clicking the tagged sr-only input would
 * pass and prove nothing (e2e/settings.spec.ts, above paintedSwitch).
 */
import { expect, type Locator, type Page } from "@playwright/test";
import { targetSelector, type HelpTarget } from "../../src/help/targets.ts";
import type {
  BranchStep,
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

class HelpStepError extends Error {
  constructor(
    scenario: HelpScenario,
    index: number,
    step: HelpStep,
    branch: string | null,
    cause: unknown,
  ) {
    const target = "target" in step ? step.target : null;
    super(
      [
        `Scenario: ${scenario.id}`,
        `Step: ${index} (${step.action})`,
        target === null
          ? "Target: —"
          : `Target: ${target.id} (kind=${target.kind})`,
        branch === null ? "Branch: —" : `Branch: ${branch}`,
        "",
        cause instanceof Error ? cause.message : String(cause),
      ].join("\n"),
    );
    this.name = "HelpStepError";
  }
}

const locate = (page: Page, target: HelpTarget): Locator =>
  page.locator(targetSelector(target));

async function holds(page: Page, condition: HelpCondition): Promise<boolean> {
  const visible = await locate(page, condition.target)
    .first()
    .isVisible()
    .catch(() => false);
  return condition.type === "target-visible" ? visible : !visible;
}

/**
 * Waits for the app to settle into one of the branch states, then takes
 * the first that holds. None holding is a failure, never a no-op — a
 * scenario whose branches have all stopped matching is exactly the stale
 * help this suite exists to catch.
 */
async function resolveBranch(
  page: Page,
  step: BranchStep,
): Promise<{ id: string; steps: HelpStep[] }> {
  const first = step.branches[0];
  if (first === undefined) throw new Error("branch step has no branches");

  let combined = locate(page, first.when.target);
  for (const branch of step.branches.slice(1)) {
    combined = combined.or(locate(page, branch.when.target));
  }
  await expect(combined.first()).toBeVisible({ timeout: 15_000 });

  for (const branch of step.branches) {
    if (await holds(page, branch.when)) {
      return { id: branch.id, steps: branch.steps };
    }
  }

  throw new Error(
    `no branch matched. Candidates: ${step.branches
      .map((b) => `${b.id} (${b.when.type} ${b.when.target.id})`)
      .join(", ")}`,
  );
}

async function runStep(page: Page, step: HelpStep): Promise<void> {
  switch (step.action) {
    case "highlight":
      await expect(locate(page, step.target).first()).toBeVisible();
      break;
    case "click":
      await locate(page, step.target).first().click();
      break;
    case "input":
      await locate(page, step.target).first().fill(step.value ?? "");
      break;
    case "select":
      await locate(page, step.target)
        .first()
        .selectOption(step.value ?? "");
      break;
    case "external":
      // Browser and OS chrome are not executable. Validated structurally
      // by the suite, never driven here.
      break;
    case "branch":
      throw new Error("branch steps are flattened before execution");
  }
}

export async function runHelpScenario(
  page: Page,
  scenario: HelpScenario,
): Promise<HelpRunTrace> {
  const trace: HelpRunTrace = {
    scenarioId: scenario.id,
    branchesTaken: [],
    stepsRun: 0,
  };

  let index = 0;
  for (const step of scenario.steps) {
    if (step.action === "branch") {
      const taken = await resolveBranch(page, step).catch((cause: unknown) => {
        throw new HelpStepError(scenario, index, step, null, cause);
      });
      trace.branchesTaken.push(taken.id);
      for (const inner of taken.steps) {
        await runStep(page, inner).catch((cause: unknown) => {
          throw new HelpStepError(scenario, index, inner, taken.id, cause);
        });
        trace.stepsRun += 1;
        index += 1;
      }
      continue;
    }

    await runStep(page, step).catch((cause: unknown) => {
      throw new HelpStepError(scenario, index, step, null, cause);
    });
    trace.stepsRun += 1;
    index += 1;
  }

  return trace;
}
```

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter gigsy-webapp typecheck
```

Expected: PASS. This is the first time the shared model is checked across
the `src`/`e2e` boundary — which is what Task 7 bought.

- [ ] **Step 4: Commit**

```bash
git add webapp/e2e/help/
git commit -m "test(help): Playwright runner executing scenarios with run traces"
```

---

### Task 9: The scenario suite and its own Playwright project

**Files:**
- Create: `webapp/e2e/help/scenarios.spec.ts`
- Modify: `webapp/playwright.config.ts:20-27`
- Modify: `webapp/package.json` (scripts)

- [ ] **Step 1: Separate the projects**

`testDir` is `./e2e`, so a new spec would otherwise join `pnpm test:e2e`
and the Definition of Done's "help specs run separately" would be false
on day one.

Modify `webapp/playwright.config.ts`:

```ts
  projects: [
    {
      // Primary devices are phones — the whole suite runs at a
      // Chromium-based handset profile (viewport, touch, mobile UA).
      name: "chromium",
      use: { ...devices["Pixel 7"] },
      // Help scenarios have their own project: they write settings and
      // refuse to run anywhere but a local stack.
      testIgnore: /help\//,
    },
    {
      name: "help",
      use: { ...devices["Pixel 7"] },
      testMatch: /help\/.*\.spec\.ts/,
    },
  ],
```

- [ ] **Step 2: Add the scripts**

Modify `webapp/package.json`:

```json
    "test:e2e": "playwright test --project=chromium",
    "help:test": "playwright test --project=help",
    "help:validate": "vitest run src/help",
```

- [ ] **Step 3: Write the suite**

Create `webapp/e2e/help/scenarios.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import {
  executableHelpScenarios,
  helpScenarios,
} from "../../src/help/registry.ts";
import { validateHelpRegistry } from "../../src/help/validate.ts";
import { prepareHelpScenario, requireLocalTarget } from "./help-fixtures.ts";
import { runHelpScenario } from "./help-runner.ts";

requireLocalTarget();

test("the registry is structurally valid", () => {
  expect(validateHelpRegistry(helpScenarios)).toEqual([]);
});

for (const scenario of executableHelpScenarios) {
  test(`help: ${scenario.id}`, async ({ page, request, baseURL }) => {
    await prepareHelpScenario(page, request, baseURL!, scenario);
    const trace = await runHelpScenario(page, scenario);

    // A run that did nothing is not a pass. deploy.yml:150 records what
    // happened last time this suite was allowed to report green while
    // skipping most of its work.
    expect(trace.stepsRun).toBeGreaterThan(0);

    // The branch a scenario documents must be the branch it took. An
    // environment change that flips one fails here instead of silently
    // changing what is under test.
    expect(trace.branchesTaken).toEqual(scenario.expectedCiBranches ?? []);
  });
}

for (const scenario of helpScenarios.filter((s) => s.executable === false)) {
  test(`help: ${scenario.id} (described, not executed)`, () => {
    const variants = scenario.variants ?? [];
    expect(variants.length).toBeGreaterThan(0);
    expect(variants.map((v) => v.environment)).toContain("fallback");
    for (const variant of variants) {
      expect(variant.steps.length).toBeGreaterThan(0);
      for (const step of variant.steps) {
        expect(step.description.trim()).not.toBe("");
      }
    }
  });
}
```

- [ ] **Step 4: Bring up the local stack**

Mirrors the `webapp-e2e-full` job. In three terminals from the repo root:

```bash
cp backend/.dev.vars.example backend/.dev.vars && pnpm --filter gigsy-backend exec wrangler d1 migrations apply gigsy-db --local
```

```bash
pnpm --filter gigsy-backend exec wrangler dev --port 8787
```

```bash
pnpm --filter gigsy-webapp dev --port 5192 --host 127.0.0.1
```

- [ ] **Step 5: Run the help suite**

```bash
E2E_BASE_URL=http://127.0.0.1:5192 E2E_REQUIRE_AUTH=1 pnpm --filter gigsy-webapp help:test
```

Expected: PASS.

**If `configure-notifications` fails on the branch assertion, do not
reach for `expectedCiBranches` first.** The likely cause is a race, not a
genuine environment difference: `Settings.tsx`'s `blocked` state waits on
a `getPushConfig()` round trip, so `push-toggle` is *transiently
rendered* before the query resolves, and a runner that commits too early
locks onto `push-available` — clicking the real subscribe button on its
way past. Editing the declaration to match would enshrine the wrong
branch and quietly retire the coverage this scenario exists for.

Diagnose first. Run it several times: intermittent means a race, and the
fix is the runner's branch-stability window, not the scenario. Only if it
fails *consistently*, and you have confirmed by looking at the running
app that the local stack genuinely offers push, should you update
`expectedCiBranches` — and then say why in the scenario's comment. Never
delete the assertion.

- [ ] **Step 6: Prove the guard works**

```bash
pnpm --filter gigsy-webapp help:test
```

Expected: FAIL immediately with the "requires E2E_BASE_URL" message,
before any browser starts.

- [ ] **Step 7: Prove a broken selector fails loudly**

Temporarily change `data-testid="settings-link"` in
`webapp/src/components/AppHeader.tsx` to `settings-link-x`, then:

```bash
E2E_BASE_URL=http://127.0.0.1:5192 pnpm --filter gigsy-webapp help:test
```

Expected: FAIL, with an error naming `Scenario: open-settings`,
`Step: 0 (click)`, `Target: settings-link (kind=element)`. **Revert the
change.**

- [ ] **Step 8: Confirm the existing suite is untouched**

```bash
E2E_BASE_URL=http://127.0.0.1:5192 pnpm --filter gigsy-webapp test:e2e
```

Expected: PASS, with exactly the test count it had before this PR — no
help specs in the list.

- [ ] **Step 9: Commit**

```bash
git add webapp/e2e/help/scenarios.spec.ts webapp/playwright.config.ts webapp/package.json
git commit -m "test(help): scenario suite with asserted branch coverage, on its own project"
```

---

### Task 10: CI

**Files:**
- Modify: `.github/workflows/deploy.yml:245-251` (the `webapp-e2e-full` job)

- [ ] **Step 1: Add the step**

Help scenarios need authentication, so they go in `webapp-e2e-full` — the
only job with a live test-auth bypass. In `webapp-e2e-preview` they would
skip and report green, which is the exact failure the comment at
`deploy.yml:150` documents.

Insert after the existing "Run the full E2E suite" step:

```yaml
      # Help scenarios prove the documented workflows are still doable.
      # They belong here rather than the preview job: that one proxies to
      # the production worker with test auth off, so these would skip and
      # report green.
      - name: Validate help scenarios
        working-directory: webapp
        env:
          E2E_BASE_URL: http://127.0.0.1:5192
          E2E_REQUIRE_AUTH: '1'
        run: pnpm help:test

      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: playwright-report-help
          path: webapp/playwright-report
          retention-days: 7
```

- [ ] **Step 2: Verify the YAML parses**

```bash
pnpm dlx js-yaml .github/workflows/deploy.yml > /dev/null && echo OK
```

Expected: `OK`.

- [ ] **Step 3: Commit and push for a real CI run**

```bash
git add .github/workflows/deploy.yml
git commit -m "ci: run help scenario validation in the full-stack E2E job"
```

Open the PR and confirm `Webapp E2E (full stack)` runs the help step and
passes. **PR 3 is complete here.**

---

### Task 11: Working days and hours

**Files:**
- Create: `webapp/src/help/scenarios/working-hours.ts`
- Modify: `webapp/src/help/registry.ts`

This is the scenario that would have been a false pass without the target
kind — keep it for exactly that reason.

- [ ] **Step 1: Write it**

Create `webapp/src/help/scenarios/working-hours.ts`:

```ts
import { HelpTarget, dayStart, dayToggle } from "../targets.ts";
import type { HelpScenario } from "../types.ts";

/**
 * Working hours decide what an agency sees on a shared availability
 * page, so this is the scenario where "the tour must not click for you"
 * stops being theoretical.
 *
 * Sunday, deliberately: its label is three characters wide, which is how
 * the untappable-switch bug finally surfaced ("why can't I switch Sun").
 */
export const configureWorkingHours: HelpScenario = {
  id: "configure-working-hours",
  title: "Set your working days and hours",
  description:
    "Free time outside these hours is your evening, not availability.",
  category: "settings",
  startRoute: "/settings",
  steps: [
    {
      action: "highlight",
      target: HelpTarget.AvailWorkingWeek,
      title: "Working hours",
      description:
        "One row per day. A day switched off is never offered, whatever your calendar says.",
    },
    {
      action: "click",
      target: dayToggle(0),
      title: "Switch a day on or off",
      description:
        "Tap the switch itself — Sunday here. The row expands to show start and end times when it is on.",
    },
    {
      action: "select",
      target: dayStart(0),
      value: "540",
      title: "Set when the day starts",
      description:
        "Times snap to quarter hours. 540 minutes is 09:00.",
    },
  ],
};
```

- [ ] **Step 2: Register and run**

Add `configureWorkingHours` to `helpScenarios` in
`webapp/src/help/registry.ts`, then with the local stack up:

```bash
pnpm --filter gigsy-webapp test && E2E_BASE_URL=http://127.0.0.1:5192 pnpm --filter gigsy-webapp help:test
```

Expected: PASS. If the `select` fails because `540` is not an option
value, read `timeChoices` in `src/lib/working-week.ts` and use a value it
actually produces — do not change the app to fit the scenario.

The click step is the one to watch: if it fails, `targetSelector` is not
reaching the paint, and that is a Task 1 bug, not a scenario bug.

- [ ] **Step 3: Verify the tour by hand**

```bash
pnpm --filter gigsy-webapp dev
```

Start the scenario and confirm the spotlight lands on the **visible
switch**, not a one-pixel box beside the label.

- [ ] **Step 4: Commit**

```bash
git add webapp/src/help/
git commit -m "feat(help): working days and hours walkthrough"
```

---

### Task 12: Email capture

**Files:**
- Create: `webapp/src/help/scenarios/email-capture.ts`
- Modify: `webapp/src/help/registry.ts`

- [ ] **Step 1: Write it**

Create `webapp/src/help/scenarios/email-capture.ts`:

```ts
import { HelpTarget } from "../targets.ts";
import type { HelpScenario } from "../types.ts";

/**
 * State-dependent: CaptureSection renders a forwarding address when
 * CAPTURE_EMAIL_DOMAIN is configured and a plain "not switched on" line
 * when it is not. Both are legitimate, so help branches rather than
 * assuming.
 *
 * The address itself is per-user. Highlight it; never read it, assert on
 * it, or record it (spec §11).
 */
export const setUpEmailCapture: HelpScenario = {
  id: "set-up-email-capture",
  title: "Forward a booking email",
  description: "Turn a booking email into a draft you review.",
  category: "settings",
  startRoute: "/settings",
  // Set to whatever the local stack actually produces — see Task 12
  // step 2 before trusting this value.
  expectedCiBranches: ["capture-configured"],
  steps: [
    {
      action: "highlight",
      target: HelpTarget.SettingsCapture,
      title: "Capture by email",
      description:
        "Forward a booking email here and it becomes a draft. Nothing is created until you confirm it.",
    },
    {
      action: "branch",
      branches: [
        {
          id: "capture-configured",
          when: { type: "target-visible", target: HelpTarget.CaptureAddress },
          steps: [
            {
              action: "highlight",
              target: HelpTarget.CaptureAddressValue,
              title: "Your forwarding address",
              description:
                "Forward to this address. What you send is read by an AI provider to pull out the client, date and amount, so don't forward anything you wouldn't put into someone else's system.",
            },
          ],
        },
        {
          id: "capture-unconfigured",
          when: {
            type: "target-visible",
            target: HelpTarget.CaptureUnconfigured,
          },
          steps: [
            {
              action: "highlight",
              target: HelpTarget.CaptureUnconfigured,
              title: "Not switched on",
              description:
                "Email capture isn't enabled for this deployment yet. A half-built address that bounces would be worse than none.",
            },
          ],
        },
      ],
    },
  ],
};
```

- [ ] **Step 2: Register, run, and correct the declared branch**

Add `setUpEmailCapture` to the registry. With the local stack up:

```bash
E2E_BASE_URL=http://127.0.0.1:5192 pnpm --filter gigsy-webapp help:test
```

If the branch assertion fails, the local stack takes the other path.
Set `expectedCiBranches` to the branch that actually ran and add a
one-line comment saying why. That is the assertion working, not failing.

- [ ] **Step 3: Commit**

```bash
git add webapp/src/help/
git commit -m "feat(help): email capture walkthrough, branching on deployment state"
```

---

### Task 13: Installing Gigsy

**Files:**
- Create: `webapp/src/help/environment.ts`
- Create: `webapp/src/help/environment.test.ts`
- Create: `webapp/src/help/scenarios/install-app.ts`
- Modify: `webapp/src/help/registry.ts`
- Modify: `webapp/src/help/runtime/HelpMenu.tsx`

- [ ] **Step 1: Write the failing detection test**

Create `webapp/src/help/environment.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { detectHelpEnvironment } from "./environment.ts";

const IOS_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";
const DESKTOP_CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const DESKTOP_EDGE = `${DESKTOP_CHROME} Edg/124.0.0.0`;
const FIREFOX =
  "Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0";

describe("detectHelpEnvironment", () => {
  it("recognises iOS Safari", () => {
    expect(detectHelpEnvironment(IOS_SAFARI)).toBe("ios-safari");
  });

  it("recognises Android Chrome", () => {
    expect(detectHelpEnvironment(ANDROID_CHROME)).toBe("android-chrome");
  });

  it("recognises desktop Chrome", () => {
    expect(detectHelpEnvironment(DESKTOP_CHROME)).toBe("desktop-chrome");
  });

  // Edge's UA contains "Chrome", so order matters.
  it("recognises Edge as Edge, not Chrome", () => {
    expect(detectHelpEnvironment(DESKTOP_EDGE)).toBe("desktop-edge");
  });

  it("falls back rather than guessing", () => {
    expect(detectHelpEnvironment(FIREFOX)).toBe("fallback");
    expect(detectHelpEnvironment("")).toBe("fallback");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
pnpm --filter gigsy-webapp test src/help/environment.test.ts
```

Expected: FAIL — `Cannot find module './environment.ts'`.

- [ ] **Step 3: Implement**

Create `webapp/src/help/environment.ts`:

```ts
/**
 * Just enough user-agent sniffing to pick install instructions, and no
 * more. Isolated so it is testable, and never trusted: the menu always
 * offers the picker, because a wrong guess would make the one piece of
 * help someone needs *before* they have the app unusable.
 */
import type { HelpEnvironment } from "./types.ts";

export function detectHelpEnvironment(
  userAgent: string = navigator.userAgent,
): HelpEnvironment {
  const ua = userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) {
    // Every iOS browser is WebKit, and every one of them installs
    // through the same Share sheet, so the distinction does not matter.
    return "ios-safari";
  }
  // Edge before Chrome: Edge's UA contains both.
  if (/Edg\//.test(ua)) return "desktop-edge";
  if (/Android/.test(ua) && /Chrome\//.test(ua)) return "android-chrome";
  if (/Chrome\//.test(ua)) return "desktop-chrome";
  return "fallback";
}
```

- [ ] **Step 4: Run and confirm it passes**

```bash
pnpm --filter gigsy-webapp test src/help/environment.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Write the scenario**

Create `webapp/src/help/scenarios/install-app.ts`:

```ts
import type { HelpScenario } from "../types.ts";

/**
 * The one scenario Gigsy cannot drive. Installing a PWA happens entirely
 * in browser and OS chrome — Safari's Share sheet, Chrome's install
 * prompt — which no page can highlight or click. Modelling these as
 * executable steps would be a lie the Playwright suite could not catch,
 * so they are external and the scenario is never executed.
 *
 * It matters more than it looks: iOS delivers push only to a PWA
 * installed to the home screen, so this is the prerequisite for the
 * notifications scenario ever reaching its available branch.
 */
export const installApp: HelpScenario = {
  id: "install-gigsy",
  title: "Install Gigsy",
  description: "Put Gigsy on your home screen or desktop.",
  category: "installation",
  executable: false,
  steps: [],
  variants: [
    {
      environment: "ios-safari",
      label: "iPhone or iPad",
      steps: [
        {
          action: "external",
          externalType: "browser-ui",
          title: "Open the Share sheet",
          description:
            "Tap the Share button in the browser toolbar — the square with an arrow pointing up.",
        },
        {
          action: "external",
          externalType: "os-ui",
          title: "Add to Home Screen",
          description:
            "Scroll down the list and tap Add to Home Screen, then Add. Open Gigsy from that icon from now on — notifications only work when you do.",
        },
      ],
    },
    {
      environment: "android-chrome",
      label: "Android",
      steps: [
        {
          action: "external",
          externalType: "browser-ui",
          title: "Open the browser menu",
          description: "Tap the three dots at the top right of Chrome.",
        },
        {
          action: "external",
          externalType: "os-ui",
          title: "Install",
          description:
            "Tap Install app (or Add to Home screen), then confirm. Gigsy appears in your app drawer.",
        },
      ],
    },
    {
      environment: "desktop-chrome",
      label: "Chrome on desktop",
      steps: [
        {
          action: "external",
          externalType: "browser-ui",
          title: "Use the install icon",
          description:
            "Click the install icon at the right-hand end of the address bar, then Install. If it isn't there, open the three-dot menu and look under Cast, save and share.",
        },
      ],
    },
    {
      environment: "desktop-edge",
      label: "Edge on desktop",
      steps: [
        {
          action: "external",
          externalType: "browser-ui",
          title: "Use the app menu",
          description:
            "Open the three-dot menu, choose Apps, then Install this site as an app.",
        },
      ],
    },
    {
      environment: "fallback",
      label: "Another browser",
      steps: [
        {
          action: "external",
          externalType: "browser-ui",
          title: "Look for Install or Add to Home Screen",
          description:
            "Most browsers offer this in their main menu or address bar. If yours doesn't, Gigsy still works as a normal bookmarked page — you just won't get notifications.",
        },
      ],
    },
  ],
};
```

- [ ] **Step 6: Render variants in the menu**

Modify `webapp/src/help/runtime/HelpMenu.tsx`. A non-executable scenario
opens an inline variant view instead of starting a tour. Add to the
imports:

```tsx
import { detectHelpEnvironment } from "../environment.ts";
import type { HelpEnvironment } from "../types.ts";
```

Add state and a renderer inside `HelpMenu`:

```tsx
  const [variantOf, setVariantOf] = useState<HelpScenario | null>(null);
  const [environment, setEnvironment] = useState<HelpEnvironment>(() =>
    detectHelpEnvironment(),
  );

  if (variantOf !== null) {
    const variants = variantOf.variants ?? [];
    const chosen =
      variants.find((v) => v.environment === environment) ??
      variants.find((v) => v.environment === "fallback");

    return (
      <div className="space-y-3 py-3" data-testid="help-variants">
        <label className="block text-xs font-semibold text-slate-500">
          Instructions for
          <Select
            className="mt-1 w-full"
            value={environment}
            data-testid="help-variant-picker"
            onChange={(e) => setEnvironment(e.target.value as HelpEnvironment)}
          >
            {variants.map((v) => (
              <option key={v.environment} value={v.environment}>
                {v.label}
              </option>
            ))}
          </Select>
        </label>

        <ol className="list-decimal space-y-2 pl-5">
          {(chosen?.steps ?? []).map((step, i) => (
            <li key={i} className="text-xs text-slate-600">
              {step.title !== undefined && (
                <span className="block font-medium text-slate-900">
                  {step.title}
                </span>
              )}
              {step.description}
            </li>
          ))}
        </ol>

        <Button variant="ghost" onClick={() => setVariantOf(null)}>
          Back to help
        </Button>
      </div>
    );
  }
```

and change the topic button's handler:

```tsx
              onClick={() =>
                scenario.executable === false
                  ? setVariantOf(scenario)
                  : void startScenario(scenario.id)
              }
```

Add `Select` to the component import from `../../components/index.ts`.

- [ ] **Step 7: Register and run everything**

Add `installApp` to `helpScenarios`, then:

```bash
pnpm --filter gigsy-webapp test && pnpm --filter gigsy-webapp typecheck
E2E_BASE_URL=http://127.0.0.1:5192 pnpm --filter gigsy-webapp help:test
```

Expected: PASS. The install scenario gets the structural test, not an
executed one — confirm it appears in the output as
`help: install-gigsy (described, not executed)`.

- [ ] **Step 8: Verify the picker by hand**

In `pnpm dev`, open Help → Install Gigsy. Confirm the detected variant is
preselected, that changing the picker changes the steps, and that no tour
starts.

- [ ] **Step 9: Commit**

```bash
git add webapp/src/help/
git commit -m "feat(help): PWA install instructions with per-platform variants"
```

---

### Task 14: Documentation

**Files:**
- Modify: `docs/plan.md` (§13, after Phase 12)
- Create: `docs/help/README.md`

- [ ] **Step 1: Record the phase**

Add to `docs/plan.md` §13, after the Phase 12 entry:

```md
- **Phase 13 — Executable help.** One `HelpScenario` model under
  `webapp/src/help/`, consumed by an in-app Driver.js tour and by a
  Playwright suite in `webapp/e2e/help/`, so a UI change that breaks a
  documented workflow fails CI rather than quietly making the help
  wrong. Targets record how a test ID relates to the control a person
  touches — most of this app's switches tag a 1×1 `sr-only` input, and
  clicking that in a test proves nothing. Scenarios that branch on
  legitimate app states declare which branch CI takes, and the suite
  asserts it. Screenshot and Markdown generation is deferred. See
  `docs/gigsy-executable-help-implementation-spec.md` and
  `2026-08-13-phase13-executable-help.md`.
```

- [ ] **Step 2: Write the contributor guide**

Create `docs/help/README.md`:

```md
# Adding a help scenario

Scenarios live in `webapp/src/help/scenarios/` and are plain data. The
model is documented in `docs/gigsy-executable-help-implementation-spec.md`.

## 1. Make sure the elements have targets

Add them to `HelpTarget` in `webapp/src/help/targets.ts`.

**Check the component before choosing a kind.** If the control is a
`Toggle`, its `data-testid` sits on a 1×1 `sr-only` input and the thing a
person touches is a sibling span — register it as `painted(...)`. If it is
a `Button`, `Select` or `Link`, use `element(...)`.

Do not infer the kind from the name. `push-toggle` is a Button;
`toggle-prefix` is a switch.

## 2. Write the scenario

Give it a `startRoute` it can actually start from — remember `settings-link`
is hidden while you are on `/settings`.

If the screen has more than one legitimate state, use a `branch` step
rather than assuming. Never instruct someone to tap a control that is
intentionally absent.

## 3. Register it

Add it to `helpScenarios` in `webapp/src/help/registry.ts`.

## 4. Validate

```bash
pnpm --filter gigsy-webapp help:validate
```

## 5. Run it

Help scenarios write settings, so they refuse to run against production.
Bring up the local stack the way `webapp-e2e-full` does in
`.github/workflows/deploy.yml`, then:

```bash
E2E_BASE_URL=http://127.0.0.1:5192 pnpm --filter gigsy-webapp help:test
```

If the scenario branches and the assertion fails, set `expectedCiBranches`
to the branch that actually ran and say why in a comment. Do not delete
the assertion — it is what stops the scenario testing something else later
without anyone noticing.

## 6. Look at it

Run `pnpm dev`, open Settings → Help, and follow it. Validation proves a
selector resolves; only your eyes prove the guidance makes sense.
```

- [ ] **Step 3: Final full verification**

```bash
pnpm typecheck && pnpm test
E2E_BASE_URL=http://127.0.0.1:5192 E2E_REQUIRE_AUTH=1 pnpm --filter gigsy-webapp test:e2e
E2E_BASE_URL=http://127.0.0.1:5192 E2E_REQUIRE_AUTH=1 pnpm --filter gigsy-webapp help:test
pnpm --filter gigsy-webapp build
```

All four must pass before this is done.

- [ ] **Step 4: Commit**

```bash
git add docs/plan.md docs/help/README.md
git commit -m "docs: record Phase 13 and how to add a help scenario"
```

**PR 4 is complete here.**

---

## Definition of done

- [ ] `HelpScenario` types exist, with targets carrying a kind.
- [ ] `resolveTarget` reaches the painted switch, proven in jsdom.
- [ ] A registry exists and is the only discovery mechanism.
- [ ] Five scenarios: navigation, conditional, interactive,
      state-dependent, external.
- [ ] A Help section is visible and keyboard-operable on Settings.
- [ ] Tours spotlight real controls, painted switches included.
- [ ] The user performs the instructed operations; the tour never clicks
      for them.
- [ ] Browser and OS actions are external steps in a non-executable
      scenario.
- [ ] A Playwright adapter executes every executable scenario.
- [ ] `pnpm typecheck` covers `e2e/`.
- [ ] Help specs run under their own project, separate from `test:e2e`.
- [ ] `help:test` refuses to run against production.
- [ ] Branch coverage is asserted against `expectedCiBranches`.
- [ ] CI runs help validation in `webapp-e2e-full`.
- [ ] Existing E2E tests pass, unmodified, at the same count.
- [ ] Application behaviour is unchanged when help is inactive.
- [ ] Driver.js is absent from the initial bundle.
- [ ] `docs/plan.md` §13 records Phase 13.
- [ ] `docs/help/README.md` explains how to add a scenario.
