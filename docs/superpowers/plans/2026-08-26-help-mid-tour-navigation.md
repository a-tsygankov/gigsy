# Help: mid-tour navigation and lazy branches — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `record-work` help scenario work for a real account, by letting a tour follow the user across a screen change and resolve its branches against the screen they are actually on.

**Architecture:** Two additions to the help model — a `navigate` step (the user's own tap moves them; the tour survives it) and an `end?: true` flag (a branch alternative that cannot continue says so). `TourRenderer`'s `flatten()` stops resolving every branch up front and instead expands one branch at a time as the tour approaches it, which is what `help-runner.ts` has always done. `record-work` then starts on `/gigs`, the user taps their own gig, and the two Work-card controls that only some gigs render sit behind branches resolved on that gig.

**Tech Stack:** TypeScript, React 19, react-router-dom, driver.js 1.8.0, vitest (jsdom), Playwright.

**Spec:** `docs/superpowers/specs/2026-08-26-help-mid-tour-navigation-design.md`

> **On the commit steps below:** this project's standing rule is that
> nothing is committed, merged or pushed without the user's direct
> instruction. The commit step in each task marks where a commit
> *belongs*; run it only once the user has said to.

---

## File structure

| File | Change | Responsibility after the change |
|---|---|---|
| `webapp/src/help/types.ts` | Modify | `HelpStepBase` (`title`, `description`, `end`), `NavigateStep`, both in the `HelpStep` union. |
| `webapp/src/help/routes.ts` | **Create** | `matchesRoute` and `allowedRoutes` — the one definition of a route pattern, shared by the provider and the Playwright runner. No DOM, no React, no Playwright. |
| `webapp/src/help/routes.test.ts` | **Create** | Unit tests for the above. |
| `webapp/src/help/validate.ts` | Modify | Structural rules for the two new model features. |
| `webapp/src/help/validate.test.ts` | Modify | A case per new rule. |
| `webapp/src/help/runtime/TourRenderer.ts` | Modify | Incremental branch expansion; terminal steps; the navigate step's wiring and watchdog suppression. |
| `webapp/src/help/runtime/TourRenderer.test.ts` | Modify | Expansion and terminal-step behaviour without Driver.js. |
| `webapp/src/help/runtime/TourRenderer.driver.test.ts` | Modify | Lazy expansion through the real library. |
| `webapp/e2e/help/help-runner.ts` | Modify | `navigate` action; terminal steps unwind the recursion. |
| `webapp/src/help/scenarios/record-work.ts` | Rewrite | Starts on `/gigs`, navigates onto the user's own gig, branches on the two conditional controls. |
| `webapp/e2e/help/help-fixtures.ts` | Modify | One unconditional gig upsert that sorts first; `ensureAtLeastOneGig` deleted. |
| `webapp/src/help/registry.test.ts` | Modify | Pins that the scenario holds no gig id. |
| `webapp/src/help/runtime/HelpProvider.tsx` | Modify | Tolerates every route the running scenario declares, and no others. |
| `webapp/src/help/runtime/HelpProvider.test.tsx` | Modify | Declared hop survives; an undeclared one still cancels. |
| `docs/help/README.md` | Modify | §2 and §6 rewritten for the new model. |
| `docs/gigsy-executable-help-implementation-spec.md` | Modify | Model section gains both additions. |

**Why this order.** The model comes first because everything else fails
to compile without it. The renderer (Tasks 3–5) comes before the
scenario, because the scenario is only correct against a renderer that
expands branches lazily. The scenario and the fixture are ONE task
(Task 7) because `help-fixtures.ts` imports the id that `record-work.ts`
stops exporting — splitting them would leave a commit that does not
typecheck. `HelpProvider` (Task 8) comes after the scenario so its test
can use the real `record-work` from the registry rather than mocking the
registry module.

**Amended during execution — run Task 6 third.** Task 1 adds
`NavigateStep` to the `HelpStep` union, which immediately trips
`help-runner.ts`'s exhaustiveness guard, so `typecheck` is red from the
end of Task 1 until Task 6 adds the `case "navigate":`. Task 6 depends
only on Task 1's model and Task 2's `matchesRoute`, so the execution
order is **1 → 2 → 6 → 3 → 4 → 5 → 7 → 8 → 9 → 10**, which restores a
green typecheck immediately instead of carrying a known-red build
through four tasks. Task numbers below are left as written so that
references to them stay stable.

---

## Task 1: The model — `end`, `NavigateStep`, and the rules that guard them

**Files:**
- Modify: `webapp/src/help/types.ts`
- Modify: `webapp/src/help/validate.ts`
- Test: `webapp/src/help/validate.test.ts`

- [ ] **Step 1: Write the failing tests**

Append these to `webapp/src/help/validate.test.ts`, inside the existing
`describe("validateHelpRegistry", ...)` block (before its closing `});`):

```ts
  it("catches a navigate step with an empty route", () => {
    const scenario: HelpScenario = {
      ...ok,
      steps: [
        {
          action: "navigate",
          target: HelpTarget.GigList,
          route: "",
          description: "Tap the one you want.",
        },
      ],
    };
    expect(messages([scenario])).toContain(
      'navigate step for target "gig-list" has no route',
    );
  });

  it("catches a navigate route that is not a path", () => {
    const scenario: HelpScenario = {
      ...ok,
      steps: [
        {
          action: "navigate",
          target: HelpTarget.GigList,
          route: "gigs/:id",
          description: "Tap the one you want.",
        },
      ],
    };
    expect(messages([scenario])).toContain(
      'navigate step for target "gig-list" has route "gigs/:id", which must start with "/"',
    );
  });

  it("catches a navigate step inside a branch, too", () => {
    const scenario: HelpScenario = {
      ...ok,
      steps: [
        {
          action: "branch",
          branches: [
            {
              id: "only",
              when: { type: "target-visible", target: HelpTarget.GigList },
              steps: [
                {
                  action: "navigate",
                  target: HelpTarget.GigList,
                  route: "",
                  description: "Tap the one you want.",
                },
              ],
            },
          ],
        },
      ],
    };
    expect(messages([scenario])).toContain(
      'branch "only" has a navigate step for target "gig-list" with no route',
    );
  });

  it("catches a bad navigate route inside a branch", () => {
    const scenario: HelpScenario = {
      ...ok,
      steps: [
        {
          action: "branch",
          branches: [
            {
              id: "only",
              when: { type: "target-visible", target: HelpTarget.GigList },
              steps: [
                {
                  action: "navigate",
                  target: HelpTarget.GigList,
                  route: "gigs/:id",
                  description: "Tap the one you want.",
                },
              ],
            },
          ],
        },
      ],
    };
    expect(messages([scenario])).toContain(
      'branch "only" has a navigate step for target "gig-list" with route "gigs/:id", which must start with "/"',
    );
  });

  it("catches a navigate step in a non-executable scenario", () => {
    // A non-executable scenario is browser and OS chrome, where there
    // is no route to reach and nothing to tap.
    const scenario: HelpScenario = {
      ...ok,
      executable: false,
      steps: [
        {
          action: "navigate",
          target: HelpTarget.GigList,
          route: "/gigs/:id",
          description: "Tap the one you want.",
        },
      ],
    };
    expect(messages([scenario])).toContain(
      "non-executable scenario has a navigate step",
    );
  });

  it("catches a terminal step that is not last in the scenario", () => {
    const scenario: HelpScenario = {
      ...ok,
      steps: [
        {
          action: "highlight",
          target: HelpTarget.SettingsNotifications,
          description: "Stops here.",
          end: true,
        },
        {
          action: "highlight",
          target: HelpTarget.SettingsCapture,
          description: "Unreachable.",
        },
      ],
    };
    expect(messages([scenario])).toContain(
      "a step marked end is not the last of the scenario's own steps",
    );
  });

  it("catches a terminal step that is not last in its branch", () => {
    const scenario: HelpScenario = {
      ...ok,
      steps: [
        {
          action: "branch",
          branches: [
            {
              id: "only",
              when: { type: "target-visible", target: HelpTarget.GigList },
              steps: [
                {
                  action: "highlight",
                  target: HelpTarget.SettingsNotifications,
                  description: "Stops here.",
                  end: true,
                },
                {
                  action: "highlight",
                  target: HelpTarget.SettingsCapture,
                  description: "Unreachable.",
                },
              ],
            },
          ],
        },
      ],
    };
    expect(messages([scenario])).toContain(
      'branch "only" has a step marked end that is not its last',
    );
  });

  it("allows a terminal step in the last position of a branch", () => {
    // The shape record-work depends on: a dead-end alternative ends,
    // and the steps written after the branch belong to the one that
    // did not.
    const scenario: HelpScenario = {
      ...ok,
      steps: [
        {
          action: "branch",
          branches: [
            {
              id: "only",
              when: { type: "target-visible", target: HelpTarget.GigList },
              steps: [
                {
                  action: "highlight",
                  target: HelpTarget.SettingsNotifications,
                  description: "Stops here.",
                  end: true,
                },
              ],
            },
          ],
        },
        {
          action: "highlight",
          target: HelpTarget.SettingsCapture,
          description: "Reached only by an alternative that did not end.",
        },
      ],
    };
    expect(validateHelpRegistry([scenario])).toEqual([]);
  });

  it("does not call a navigate step external", () => {
    // `everyStepExternal` decides "executable but every step is
    // external". A navigate step is something a person does, so it must
    // never satisfy that.
    const scenario: HelpScenario = {
      ...ok,
      steps: [
        {
          action: "navigate",
          target: HelpTarget.GigList,
          route: "/gigs/:id",
          description: "Tap the one you want.",
        },
      ],
    };
    expect(messages([scenario])).not.toContain(
      "scenario is executable but every step is external",
    );
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter gigsy-webapp exec vitest run src/help/validate.test.ts`

Expected: FAIL. The `action: "navigate"` literals do not typecheck
(`Type '"navigate"' is not assignable...`), and `end: true` is not a
known property, so the file does not compile.

- [ ] **Step 3: Add the model to `types.ts`**

In `webapp/src/help/types.ts`, replace the `HelpStep` union block and the
five step interfaces that follow it. The union's comment changes because
the thing it said would never be needed is now needed:

```ts
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
```

Then have `ExternalInstructionStep` extend the base too, deleting its
now-duplicated `title?` and `description` members:

```ts
/** Browser and OS operations Gigsy can neither drive nor highlight. */
export interface ExternalInstructionStep extends HelpStepBase {
  action: "external";
  externalType: "browser-ui" | "os-ui";
}
```

Leave `BranchStep`, `HelpBranch`, `HelpCondition`, `HelpVariant` and
`HelpScenario` exactly as they are.

- [ ] **Step 4: Add the rules to `validate.ts`**

In `webapp/src/help/validate.ts`, replace the `checkExternal` helper and
the top-level step loop inside `validateHelpRegistry` with this. The
helper is renamed because it now checks more than external steps:

```ts
    const branchIds = new Set<string>();

    /** Per-step rules, applied identically at the top level and inside
     *  a branch. `where` is the only difference, and it is only there
     *  so a message says which branch to look in. */
    const checkStep = (step: HelpStep, where: string): void => {
      const inBranch = where !== "";

      if (step.action === "external" && step.description.trim() === "") {
        report(
          inBranch
            ? `${where} has an external step with an empty description`
            : "external step has an empty description",
        );
      }

      if (step.action !== "navigate") return;

      if (!executable) report("non-executable scenario has a navigate step");

      const id = step.target.id;
      if (step.route.trim() === "") {
        report(
          inBranch
            ? `${where} has a navigate step for target "${id}" with no route`
            : `navigate step for target "${id}" has no route`,
        );
      } else if (!step.route.startsWith("/")) {
        const tail = `route "${step.route}", which must start with "/"`;
        report(
          inBranch
            ? `${where} has a navigate step for target "${id}" with ${tail}`
            : `navigate step for target "${id}" has ${tail}`,
        );
      }
    };

    /** A terminal step with steps written after it in the same list
     *  silently drops them — the class of quiet wrongness this file
     *  exists to make loud. A terminal step in the LAST position of a
     *  scenario's own steps is a harmless no-op and is not reported:
     *  that would be the validator arguing about redundancy rather than
     *  correctness. */
    const checkTerminalPlacement = (list: HelpStep[], branchId?: string): void => {
      list.forEach((step, index) => {
        if (step.action === "branch" || step.end !== true) return;
        if (index === list.length - 1) return;
        report(
          branchId === undefined
            ? "a step marked end is not the last of the scenario's own steps"
            : `branch "${branchId}" has a step marked end that is not its last`,
        );
      });
    };

    checkTerminalPlacement(scenario.steps);

    for (const step of scenario.steps) {
      checkStep(step, "");
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
        checkTerminalPlacement(branch.steps, branch.id);
        for (const inner of branch.steps) {
          checkStep(inner, `branch "${branch.id}"`);
        }
      }
    }
```

`everyStepExternal` needs no change: it already returns `false` for any
non-external, non-branch step, and a navigate step is one. The new test
pins that.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter gigsy-webapp exec vitest run src/help/validate.test.ts`

Expected: PASS, including every pre-existing case.

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter gigsy-webapp typecheck`

Expected: **exactly one error**, and only this one —
`webapp/e2e/help/help-runner.ts(432,13): Type 'NavigateStep' is not
assignable to type 'never'`. That is the exhaustiveness guard in
`performAction`'s `switch`, whose own comment predicts it will fail to
compile the moment `HelpStep` grows a new action. It is working, not
broken; Task 3 (the Playwright runner) is what clears it, and typecheck
is red until then. A SECOND error is a real problem — stop and report it.

(Bare `tsc --noEmit` always exits 0 in this package — use the script,
which runs `tsc -b`.)

- [ ] **Step 7: Commit**

```bash
git add webapp/src/help/types.ts webapp/src/help/validate.ts webapp/src/help/validate.test.ts && git commit -m "feat(help): add a navigate step and a terminal-step flag to the model"
```

---

## Task 2: `routes.ts` — the one definition of a route pattern

**Files:**
- Create: `webapp/src/help/routes.ts`
- Test: `webapp/src/help/routes.test.ts`

- [ ] **Step 1: Write the failing test**

Create `webapp/src/help/routes.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { allowedRoutes, matchesRoute } from "./routes.ts";
import { HelpTarget } from "./targets.ts";
import type { HelpScenario } from "./types.ts";

describe("matchesRoute", () => {
  it("matches a literal pattern exactly", () => {
    expect(matchesRoute("/gigs", "/gigs")).toBe(true);
    expect(matchesRoute("/gigs", "/gigs/abc")).toBe(false);
    expect(matchesRoute("/gigs", "/")).toBe(false);
  });

  it("does not match a longer literal that merely starts the same", () => {
    // The reason this is a segment comparison and not `startsWith`.
    expect(matchesRoute("/gigs", "/gigsy")).toBe(false);
  });

  it("matches exactly one segment per :param", () => {
    expect(matchesRoute("/gigs/:id", "/gigs/abc")).toBe(true);
    expect(matchesRoute("/gigs/:id", "/gigs/abc/edit")).toBe(false);
    expect(matchesRoute("/gigs/:id", "/gigs")).toBe(false);
  });

  it("treats a param as required, not optional", () => {
    expect(matchesRoute("/gigs/:id", "/gigs/")).toBe(false);
  });

  it("handles more than one param", () => {
    expect(matchesRoute("/a/:x/b/:y", "/a/1/b/2")).toBe(true);
    expect(matchesRoute("/a/:x/b/:y", "/a/1/c/2")).toBe(false);
  });
});

const base: HelpScenario = {
  id: "s",
  title: "S",
  category: "gigs",
  startRoute: "/gigs",
  steps: [
    {
      action: "highlight",
      target: HelpTarget.GigList,
      description: "Here.",
    },
  ],
};

describe("allowedRoutes", () => {
  it("is just the start route when nothing navigates", () => {
    expect(allowedRoutes(base, "/somewhere")).toEqual(["/gigs"]);
  });

  it("falls back to the given pathname when the scenario has no startRoute", () => {
    const { startRoute: _unused, ...noStart } = base;
    expect(allowedRoutes(noStart, "/somewhere")).toEqual(["/somewhere"]);
  });

  it("includes a navigate step's route", () => {
    const scenario: HelpScenario = {
      ...base,
      steps: [
        {
          action: "navigate",
          target: HelpTarget.GigList,
          route: "/gigs/:id",
          description: "Tap one.",
        },
      ],
    };
    expect(allowedRoutes(scenario, "/somewhere")).toEqual(["/gigs", "/gigs/:id"]);
  });

  it("reaches a navigate step nested inside a branch", () => {
    // The only place record-work's own navigate step lives, so this is
    // the case that actually matters.
    const scenario: HelpScenario = {
      ...base,
      steps: [
        {
          action: "branch",
          branches: [
            {
              id: "showing",
              when: { type: "target-visible", target: HelpTarget.GigList },
              steps: [
                {
                  action: "navigate",
                  target: HelpTarget.GigList,
                  route: "/gigs/:id",
                  description: "Tap one.",
                },
              ],
            },
          ],
        },
      ],
    };
    expect(allowedRoutes(scenario, "/somewhere")).toEqual(["/gigs", "/gigs/:id"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter gigsy-webapp exec vitest run src/help/routes.test.ts`

Expected: FAIL — `Failed to resolve import "./routes.ts"`.

- [ ] **Step 3: Write the implementation**

Create `webapp/src/help/routes.ts`:

```ts
/**
 * Route patterns, as plain data.
 *
 * A `navigate` step names where the user's tap lands, and three places
 * need to agree about what that name means: HelpProvider, which decides
 * whether a route change is the declared hop or someone walking out on
 * the tour; the Playwright runner, which waits for the URL; and anyone
 * reading a scenario. One definition here rather than three regexes
 * that drift.
 *
 * Deliberately not react-router's `matchPath`, and not for the reason
 * you might assume: that function is pure and runs fine in Node with no
 * DOM and no mounted Router — checked against this repo's own
 * node_modules, not guessed. The reasons are that it is
 * CASE-INSENSITIVE by default (`/Gigs/:id` matches `/gigs/abc` unless
 * every call site passes `{ caseSensitive: true }`), and that it
 * implements a far larger pattern language than a help scenario needs —
 * wildcards, optional segments, `pathnameBase` — whose semantics are
 * free to shift under a react-router upgrade. A tour torn down
 * mid-step because a matcher quietly got more generous is a bug nobody
 * would think to look for here.
 *
 * The subset a help scenario needs is one segment per ":param", and
 * that is all this implements: no wildcards, no optional segments, no
 * search or hash. Staying dependency-free also keeps react-router out
 * of the Playwright runner's module graph — `e2e/help/help-runner.ts`
 * imports this file — which is the same instinct that keeps types.ts
 * free of React.
 */
import type { HelpScenario, HelpStep } from "./types.ts";

/** Segment-by-segment, never `startsWith`: "/gigs" must not match
 *  "/gigsy", and "/gigs/:id" must not match "/gigs/abc/edit". Splitting
 *  on "/" makes both fall out of a length check plus a per-segment
 *  comparison, with no escaping to get wrong — `pattern` comes from a
 *  scenario file and `pathname` from the router, and neither is ever
 *  compiled into anything, so there is no injection surface here at
 *  all. */
export function matchesRoute(pattern: string, pathname: string): boolean {
  const want = pattern.split("/");
  const got = pathname.split("/");
  if (want.length !== got.length) return false;
  return want.every((segment, i) =>
    // A param matches one NON-EMPTY segment: "/gigs/" is not a gig.
    segment.startsWith(":") ? got[i] !== "" : segment === got[i],
  );
}

/** Every route a running scenario may legitimately be on: where it
 *  starts, plus wherever each of its navigate steps lands — branches
 *  included, since that is where `record-work`'s own navigate step
 *  lives.
 *
 *  `fallback` is what a scenario with no `startRoute` starts on, which
 *  is wherever the user already was. HelpProvider passes its current
 *  pathname. */
export function allowedRoutes(scenario: HelpScenario, fallback: string): string[] {
  const routes = [scenario.startRoute ?? fallback];

  const walk = (steps: HelpStep[]): void => {
    for (const step of steps) {
      if (step.action === "branch") {
        for (const branch of step.branches) walk(branch.steps);
        continue;
      }
      if (step.action === "navigate") routes.push(step.route);
    }
  };
  walk(scenario.steps);

  return routes;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter gigsy-webapp exec vitest run src/help/routes.test.ts`

Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add webapp/src/help/routes.ts webapp/src/help/routes.test.ts && git commit -m "feat(help): add route-pattern matching shared by the provider and the runner"
```

---

## Task 3: Terminal steps stop the flat list

**Files:**
- Modify: `webapp/src/help/runtime/TourRenderer.ts`
- Test: `webapp/src/help/runtime/TourRenderer.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to the existing `describe("flatten", ...)` block in
`webapp/src/help/runtime/TourRenderer.test.ts`:

```ts
  it("stops at a terminal step and drops everything after it", async () => {
    const { flatten } = await import("./TourRenderer.ts");
    const stop: HighlightStep = {
      action: "highlight",
      target: HelpTarget.SettingsLink,
      description: "stop",
      end: true,
    };
    const unreachable: HighlightStep = {
      action: "highlight",
      target: HelpTarget.SettingsHelp,
      description: "unreachable",
    };

    await expect(
      flatten([stop, unreachable], new AbortController().signal),
    ).resolves.toEqual([stop]);
  });

  it("lets a terminal step inside a branch end the whole scenario", async () => {
    // The case record-work depends on: `no-gigs-yet` has no row to tap,
    // so the Work-card steps written AFTER the branch must not run.
    const { flatten } = await import("./TourRenderer.ts");
    document.body.innerHTML = "";
    const deadEnd: HighlightStep = {
      action: "highlight",
      target: HelpTarget.GigAdd,
      description: "nothing to find yet",
      end: true,
    };
    const afterTheBranch: HighlightStep = {
      action: "highlight",
      target: HelpTarget.GigStatus,
      description: "only for the branch that continued",
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
      flatten([branch, afterTheBranch], new AbortController().signal),
    ).resolves.toEqual([deadEnd]);
  });

  it("keeps going past a branch whose taken alternative did not end", async () => {
    const { flatten } = await import("./TourRenderer.ts");
    stubVisible("gig-filters");
    const inBranch: HighlightStep = {
      action: "highlight",
      target: HelpTarget.GigSearch,
      description: "in the branch",
    };
    const afterTheBranch: HighlightStep = {
      action: "highlight",
      target: HelpTarget.GigStatus,
      description: "after the branch",
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
      flatten([branch, afterTheBranch], new AbortController().signal),
    ).resolves.toEqual([inBranch, afterTheBranch]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter gigsy-webapp exec vitest run src/help/runtime/TourRenderer.test.ts`

Expected: FAIL on the first two — `flatten` returns `[stop, unreachable]`
and `[deadEnd, afterTheBranch]`, because nothing reads `end` yet. The
third passes already.

- [ ] **Step 3: Rewrite `flatten` as a resumable walker**

In `webapp/src/help/runtime/TourRenderer.ts`, replace the whole
`export async function flatten(...)` block with the following. `flatten`
keeps its signature and behaviour — Task 5 reuses the two new helpers to
do the same work one branch at a time:

```ts
/** The scenario, half-resolved: the flat steps that are known, the
 *  model steps still waiting for a DOM to resolve against, and whether
 *  a terminal step has already closed the walk.
 *
 *  Two consumers: `flatten`, which loops until `rest` is empty, and
 *  `runTour`, which stops after each branch so the next one is resolved
 *  against the screen the user has reached rather than the one they
 *  started on. */
interface Expansion {
  flat: FlatStep[];
  rest: HelpStep[];
  /** Model steps not yet resolved. Empty both when the walk reached
   *  the natural end of the list and when a terminal step closed it
   *  early — deliberately not distinguished, because no consumer has
   *  ever needed to: "nothing left to resolve" is the only question
   *  anyone asks. An `ended` flag alongside this was removed for that
   *  reason; it was a second encoding of the same state that four
   *  return sites had to keep in sync by hand. */
}

/** Appends steps until a terminal step (stop, drop the rest) or a
 *  branch (stop, leave the branch at the head of `rest`). Touches no
 *  DOM: it never resolves a branch itself, which is what lets the
 *  caller decide WHEN that resolution happens. */
function takeUntilBranch(steps: HelpStep[]): Expansion {
  const flat: FlatStep[] = [];
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i]!;
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
 *  Exported for unit testing alongside `flatten`. */
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
  // validate.ts rejects a branch step whose own steps nest another
  // branch, so this should never happen — but if it somehow did, that
  // is the same kind of failure an unmatched branch is, not a step to
  // silently drop from the tour.
  if (taken.some((step) => !isFlatStep(step))) return null;

  const inner = takeUntilBranch(taken);
  // `inner.rest` is necessarily empty — a branch's steps hold no branch
  // — so the only thing it can tell us is whether the alternative
  // closed early. If it did, everything written after this branch step
  // is unreachable, which is the entire point of the flag.
  // Did the taken alternative END, or merely finish? Both leave
  // `inner.rest` empty, and only the first may drop what follows the
  // branch — so ask the steps themselves. `takeUntilBranch` stops ON a
  // terminal step, so a terminal alternative is exactly one whose last
  // appended step carries the flag.
  if (inner.flat.at(-1)?.end === true) return { flat: inner.flat, rest: [] };

  const after = takeUntilBranch(steps.slice(1));
  return {
    flat: [...inner.flat, ...after.flat],
    rest: after.rest,
  };
}

/** Flattens every branch against the live DOM in one pass. Still used
 *  by anything that wants the whole list at once; `runTour` no longer
 *  does, because resolving a branch before the user has reached its
 *  screen is exactly the bug this file used to have.
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter gigsy-webapp exec vitest run src/help/runtime/TourRenderer.test.ts`

Expected: PASS, including every pre-existing `flatten` test.

- [ ] **Step 5: Commit**

```bash
git add webapp/src/help/runtime/TourRenderer.ts webapp/src/help/runtime/TourRenderer.test.ts && git commit -m "feat(help): let a terminal step end a tour from inside a branch"
```

---

## Task 4: The navigate step in the tour renderer

**Files:**
- Modify: `webapp/src/help/runtime/TourRenderer.ts`
- Test: `webapp/src/help/runtime/TourRenderer.test.ts`

- [ ] **Step 1: Write the failing test**

Append a new `describe` block at the end of
`webapp/src/help/runtime/TourRenderer.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter gigsy-webapp exec vitest run src/help/runtime/TourRenderer.test.ts -t isUserInteraction`

Expected: FAIL — `isUserInteraction` is not an export of
`./TourRenderer.ts`.

- [ ] **Step 3: Export it and teach it the new step**

In `webapp/src/help/runtime/TourRenderer.ts`, replace the
`isUserInteraction` function:

```ts
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
```

- [ ] **Step 4: Wire the step's popover and listener**

Still in `TourRenderer.ts`, inside `runTour`'s step-building loop,
replace the `showButtons` expression:

```ts
              // A click or navigate step advances by being done, not by
              // pressing Next.
              showButtons:
                step.action === "click" || step.action === "navigate"
                  ? ["close"]
                  : ["next", "previous", "close"],
```

And in `onHighlightStarted`, replace everything from
`if (step.action === "external") return;` down to the end of the click
wiring with:

```ts
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
      // a re-render that drops the container, would otherwise leave the
      // tour on a dead popover until the NEXT step's budget runs out
      // and then name the wrong target. So the TAP silences it, rather
      // than the step type disabling it.
      let advanced = false;
      stepCleanups.push(
        watchTarget(step.target, () => {
          if (advanced) return;
          options.onUnavailable(`target ${step.target.id} disappeared`);
          endTourAfterHook();
        }),
      );

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
        // its own whitespace (space-y-3's 12px gaps) as easily as on a
        // row. That tap navigates nowhere, and with no Next button on
        // this step there is no way back from advancing on it.
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
      // Not `{ once: true }`: with the guard above, "fired" and
      // "consumed" are no longer the same event.
      operable.addEventListener(eventName, onFire);
      stepCleanups.push(() =>
        operable.removeEventListener(eventName, onFire),
      );
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter gigsy-webapp exec vitest run src/help/runtime/TourRenderer.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add webapp/src/help/runtime/TourRenderer.ts webapp/src/help/runtime/TourRenderer.test.ts && git commit -m "feat(help): let a tour survive the screen change a navigate step causes"
```

---

## Task 5: Lazy branch resolution in `runTour`

**Files:**
- Modify: `webapp/src/help/runtime/TourRenderer.ts` (`runTour`)
- Test: `webapp/src/help/runtime/TourRenderer.driver.test.ts`

This is the substantial one. `runTour` stops calling `flatten` and keeps
an `Expansion` it grows as the tour advances.

- [ ] **Step 1: Write the failing test**

`TourRenderer.driver.test.ts` already has `start(steps, onUnavailable)`,
`popoverText()`, `waitFor(predicate)` and an `afterEach` that cancels
every tour. It has no rect stub, and branch conditions need one, so add
this helper next to `popoverText`:

```ts
/** jsdom computes no layout, so every rect is zero-sized and
 *  `isVisible` — which checks size before anything else, precisely
 *  because a `peer sr-only` input passes `checkVisibility()` — would
 *  call every element invisible. A branch condition needs a real size
 *  to ever hold. */
function paint(testId: string): void {
  const el = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  el!.getBoundingClientRect = () =>
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
}

/** The Next button Driver.js is currently painting. */
function clickNext(): void {
  document.querySelector<HTMLElement>(".driver-popover-next-btn")!.click();
}
```

Then append this `it` to the existing
`describe("runTour against the real driver.js", ...)` block:

```ts
  it("resolves a branch against the DOM as it is when the tour reaches it", async () => {
    // The whole point of expanding lazily. This branch's condition is
    // FALSE when the tour starts and true by the time the tour gets to
    // it — which is exactly what a navigate step does to the page.
    // Flattening up front, as this file used to, locks in the wrong
    // alternative and spotlights a control the user will never see.
    //
    // Three leading steps, not one, so the timing is decided rather
    // than raced: `readyToGrow` fires no earlier than the second-to-last
    // known step, which is index 1 here — after the element below has
    // been inserted.
    document.body.innerHTML = `
      <a data-testid="gig-status">Status</a>
      <a data-testid="gig-break">Break</a>
      <a data-testid="gig-payments">Payments</a>`;
    paint("gig-status");
    paint("gig-break");
    paint("gig-payments");

    const onUnavailable = vi.fn();
    await start(
      [
        { action: "highlight", target: HelpTarget.GigStatus, description: "one" },
        { action: "highlight", target: HelpTarget.GigBreak, description: "two" },
        { action: "highlight", target: HelpTarget.GigPayments, description: "three" },
        {
          action: "branch",
          branches: [
            {
              id: "appeared",
              when: { type: "target-visible", target: HelpTarget.GigOverride },
              steps: [
                {
                  action: "highlight",
                  target: HelpTarget.GigOverride,
                  description: "appeared",
                },
              ],
            },
            {
              id: "absent",
              when: { type: "target-missing", target: HelpTarget.GigOverride },
              steps: [
                {
                  action: "highlight",
                  target: HelpTarget.GigStatus,
                  description: "absent",
                },
              ],
            },
          ],
        },
      ],
      onUnavailable,
    );

    expect(await waitFor(() => popoverText() === "one")).toBe(true);

    // The control the branch asks about arrives only now, while the
    // tour is already driving.
    document.body.insertAdjacentHTML(
      "beforeend",
      '<input data-testid="gig-override" />',
    );
    paint("gig-override");

    clickNext();
    expect(await waitFor(() => popoverText() === "two")).toBe(true);
    clickNext();
    expect(await waitFor(() => popoverText() === "three")).toBe(true);
    clickNext();

    expect(await waitFor(() => popoverText() === "appeared")).toBe(true);
    expect(onUnavailable).not.toHaveBeenCalled();
  });

  it("ends the tour on a terminal step inside a branch", async () => {
    // record-work's `no-gigs-yet` shape: the alternative ends, and the
    // step written after the branch is never reached.
    document.body.innerHTML = `
      <a data-testid="gig-add">Add</a>
      <a data-testid="gig-status">Status</a>`;
    paint("gig-add");
    paint("gig-status");

    const onUnavailable = vi.fn();
    await start(
      [
        {
          action: "branch",
          branches: [
            {
              id: "no-gigs-yet",
              when: { type: "target-missing", target: HelpTarget.GigFilters },
              steps: [
                {
                  action: "highlight",
                  target: HelpTarget.GigAdd,
                  description: "nothing yet",
                  end: true,
                },
              ],
            },
          ],
        },
        {
          action: "highlight",
          target: HelpTarget.GigStatus,
          description: "unreachable",
        },
      ],
      onUnavailable,
    );

    expect(await waitFor(() => popoverText() === "nothing yet")).toBe(true);
    // One step only, so the button is Done and pressing it ends the
    // tour rather than moving to "unreachable".
    clickNext();
    expect(await waitFor(() => driverResidue().popover === false)).toBe(true);
    expect(onUnavailable).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter gigsy-webapp exec vitest run src/help/runtime/TourRenderer.driver.test.ts`

Expected: the first new test FAILS — the popover reads "absent",
because `runTour` still flattens every branch before `tour.drive()` and
`gig-override` was not in the DOM at that moment. (The second passes
already, on Task 3's work; it is here to keep that behaviour pinned
through this task's rewrite.)

- [ ] **Step 3: Extract the step builder**

In `webapp/src/help/runtime/TourRenderer.ts`, add this module-level
function immediately above `export async function runTour`. Its body is
the loop currently inside `runTour`, lifted verbatim apart from taking
its inputs as parameters:

```ts
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
```

- [ ] **Step 4: Replace `runTour`'s step building with an expansion**

In `runTour`, replace everything from `const flat = await flatten(...)`
down to and including the `if (options.signal.aborted) return () =>
undefined;` that follows the (now-extracted) step-building loop, with:

```ts
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

  /** Hand Driver.js the steps we know about now.
   *
   *  NOT `tour.setSteps`. Measured under 1.8.0: `setSteps` is
   *  `d(); resetState(); setConfig({...})`, and `resetState()` empties
   *  the state bag — `activeIndex` included — after which `moveNext`'s
   *  guard bails and the Next button is dead on exactly the step this
   *  grow was for. `setConfig` is the half that does the work. Dropping
   *  `d()` is deliberate too: it cancels a pending `waitForElement`,
   *  which is the last thing we want under a step still waiting for its
   *  target to arrive.
   *
   *  Safe mid-step: Driver copies a popover's button label and its
   *  `{{total}}` at render time and never re-renders them, so growing
   *  cannot disturb what is on screen — and `moveNext` re-reads
   *  `getConfig("steps")`, so it sees the grown array. */
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

  // Resolve eagerly while no user interaction precedes the branch.
  //
  // Such a branch asks about the screen `startRoute` has already landed
  // on, so resolving it now is not the bug this task fixes — it is what
  // `flatten` did, and the reason every scenario that branched before
  // this change behaves identically after it.
  //
  // It must happen before `drive()`, not after: Driver copies a
  // popover's button label and `{{total}}` at render time and never
  // re-renders them, so a tour that starts with one step known shows
  // "1 of 1" and a DONE button — on the first step of
  // `configure-notifications`, `configure-working-hours` and
  // `set-up-email-capture`, whose branches sit at index 1. Growing
  // afterwards advances correctly but cannot relabel what is painted.
  //
  // `record-work`'s pay branches sit after a navigate step, so this
  // loop stops before them and they stay lazy — the point of the task.
  while (rest.length > 0 && !known.some(isUserInteraction)) {
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
```

- [ ] **Step 5: Add the advance handler and the resolve-ahead trigger**

Still in `runTour`, add this immediately above the `const tour =
driver({...})` call:

```ts
  /** Can the branch at the head of `rest` be resolved against the DOM
   *  the user is looking at right now?
   *
   *  Safe exactly when no un-performed interaction stands between here
   *  and the branch — including the step being read at this moment. A
   *  click, input, select or navigate step that is still on screen has
   *  been SHOWN, not performed, so the DOM its branch asks about does
   *  not exist yet. Resolving there would measure the screen the user
   *  is about to leave, which is the whole bug this task removes.
   *
   *  Resolving as early as that rule allows is deliberate, not greedy:
   *  the array has to have grown before Driver paints the boundary
   *  step's popover, because `B()` copies `nextBtnText` and `{{total}}`
   *  at render time and never re-renders them. It also shrinks the
   *  window in which `advance` has to await a grow at all. */
  const readyToGrow = (index: number | undefined): boolean =>
    index !== undefined &&
    rest.length > 0 &&
    !known.slice(index).some(isUserInteraction);

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
      // Someone else already moved us on while this was settling — a
      // second Next press, a held ArrowRight, or the tap on a
      // click/navigate step. Advancing again would run off the end and
      // destroy the tour with no banner. Measured under the real
      // library: two presses 30ms apart did exactly that.
      if (tour.getActiveIndex() !== index) return;
    }
    tour.moveNext();
  };
```

Then, in the `driver({...})` config object:

- replace `showProgress`, so a scenario that will grow still shows it:

```ts
    showProgress: driveSteps.length > 1 || rest.length > 0,
```

- add the next handler beside `popoverClass`:

```ts
    // Replaces Driver's internal advance for every step: its `L()`
    // prefers a step's own `onNextClick`, then this, and falls back to
    // this for the Done button too because we set no `onDoneClick`.
    onNextClick: () => {
      void advance();
    },
```

- and in `onHighlightStarted`, add the resolve-ahead trigger immediately
  before the line `if (step.action !== "click" && step.action !==
  "navigate") return;`, so it runs for every kind of step:

```ts
      // Resolve the next branch now, against the screen this step is
      // on, so it is already expanded by the time anyone presses Next.
      // `advance` awaits it if they get there first.
      if (readyToGrow(tour.getActiveIndex())) void grow();
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter gigsy-webapp exec vitest run src/help/runtime/`

Expected: PASS, including both new driver tests and every pre-existing
one. The driver suite takes ~16s on its own.

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter gigsy-webapp typecheck`

Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add webapp/src/help/runtime/TourRenderer.ts webapp/src/help/runtime/TourRenderer.driver.test.ts && git commit -m "feat(help): resolve a tour's branches where it reaches them, not before it starts"
```

---

## Task 6: The Playwright runner performs a navigate step

**Files:**
- Modify: `webapp/e2e/help/help-runner.ts`

There is no unit harness for this file — it runs under Playwright
against a live stack, and Task 10 is where it is exercised. What this
task must not do is change behaviour for any existing scenario.

- [ ] **Step 1: Add the import**

At the top of `webapp/e2e/help/help-runner.ts`, beside the existing
`targetSelector` import:

```ts
import { matchesRoute } from "../../src/help/routes.ts";
```

- [ ] **Step 2: Add the navigate case to `performAction`**

Insert this into the `switch (step.action)` block, immediately after the
`case "select":` block and before `case "external":`:

```ts
    case "navigate": {
      const container = locatorFor(page, step.target);
      await expect(container).toBeVisible({ timeout: TARGET_APPEAR_TIMEOUT_MS });
      // The tour spotlights a container of choices and lets the person
      // pick their own row (TourRenderer.ts wires the listener on the
      // container and lets the tap bubble). The runner has no
      // preference and cannot have one — which row is "yours" is the
      // one thing a scenario deliberately does not know — so it takes
      // the first. A stand-in for the tap, not a claim about which row
      // matters.
      //
      // `a[href]` rather than the container itself: clicking the
      // wrapper lands wherever its centre happens to be, which is a row
      // on a full list and padding on a short one.
      const before = page.url();
      await container.locator("a[href]").first().click();
      // `url.href !== before` is load-bearing. Playwright's own
      // `waitForURL` tests the CURRENT url first and returns without
      // waiting at all if it already matches, so a hop whose
      // destination pattern matches where you already are would assert
      // nothing — a swallowed click or a dead link would still report
      // green. No race: on that short-circuit path the predicate sees
      // `before` itself and returns false, falling through to the real
      // navigation wait.
      try {
        await page.waitForURL(
          (url) => url.href !== before && matchesRoute(step.route, url.pathname),
          { timeout: TARGET_APPEAR_TIMEOUT_MS },
        );
      } catch (cause) {
        // The one path in this file that has to build its own message.
        // Playwright fills its "waiting for" text only when the url
        // argument is a string; with a predicate it reports a bare
        // `waiting for navigation`, so the route is said here or it is
        // said nowhere — and `stepFailure`'s `Target:` line names the
        // container, which was visible and clicked fine.
        throw new Error(
          `tapped the first link inside "${step.target.id}" but the URL never ` +
            `matched "${step.route}" within ${TARGET_APPEAR_TIMEOUT_MS}ms ` +
            `(still on ${new URL(page.url()).pathname})`,
          { cause },
        );
      }
      return;
    }
```

Note on `TARGET_APPEAR_TIMEOUT_MS`: its doc comment claims nothing in
`playwright.config.ts` sets an `expect` timeout. That stopped being true
in `e7c9ffa`, which gave the `help` project `expect: { timeout: 15_000 }`
for cold starts — so passing this constant explicitly now *narrows* 15s
to 10s. Correct the comment to say so. **Do not change the number here**:
those budgets were tuned against a live stack, this branch cannot run
the Playwright suites until Task 10, and guessing is how the 5s-inside-30s
bug in that same comment's history happened. Settle it at Task 10 with
real timing.

The `default:` exhaustiveness guard below it compiles again — that guard
was written for exactly this moment, and it is what would have failed
the build had this case been forgotten. Its own comment is now written
in the wrong tense ("if HelpStep ever grows a sixth action… this line
fails to compile"), since it just did. Rewrite that sentence so it reads
true after the fact — it should say that the guard already caught the
navigate step once and will catch the next one the same way — without
losing what it is FOR: turning a silently-skipped step that still
increments `stepsRun` into a build failure.

- [ ] **Step 3: Make a terminal step unwind the recursion**

Replace `runSteps` entirely:

```ts
/** Whether the caller should keep going. A terminal step ends the whole
 *  scenario, not just the branch it sits in — which is the point of it
 *  (types.ts's `HelpStepBase.end`), so the signal has to travel back
 *  out through this function's own recursion. */
type StepOutcome = "continue" | "stop";

async function runSteps(
  page: Page,
  scenario: HelpScenario,
  steps: HelpStep[],
  trace: HelpRunTrace,
  branchId: string | undefined,
  cursor: { next(): number },
): Promise<StepOutcome> {
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
      const outcome = await runSteps(
        page,
        scenario,
        taken.steps,
        trace,
        taken.id,
        cursor,
      );
      if (outcome === "stop") return "stop";
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
    // expansion — which replaces a branch step with its taken steps
    // rather than counting the branch node itself. The two adapters
    // must agree on "how many steps is this scenario": a future doc
    // generator reading both would otherwise see them disagree about a
    // scenario neither actually treats differently.
    trace.stepsRun += 1;

    if (step.end === true) return "stop";
  }

  return "continue";
}
```

In `runHelpScenario`, the call site is unchanged in shape — the outcome
is discarded, because at the top level "stopped" and "ran out of steps"
mean the same thing:

```ts
  await runSteps(page, scenario, scenario.steps, trace, undefined, makeStepCursor());
```

Update that function's doc comment, whose last sentence is now wrong.
Replace `` `startRoute` is handled by the caller's fixture
(`prepareHelpScenario`) before this runs; there is no navigate step in
the model. `` with:

```
 * `startRoute` is handled by the caller's fixture
 * (`prepareHelpScenario`) before this runs; a `navigate` step is what
 * moves the page after that, and a step marked `end` stops the
 * scenario wherever it sits.
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter gigsy-webapp typecheck`

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add webapp/e2e/help/help-runner.ts && git commit -m "feat(help): teach the Playwright runner to follow a navigate step"
```

---

## Task 7: `record-work` reaches a gig the way a person does

**Files:**
- Modify: `webapp/src/help/scenarios/record-work.ts` (full rewrite)
- Modify: `webapp/e2e/help/help-fixtures.ts`
- Test: `webapp/src/help/registry.test.ts`

One task, not two: `help-fixtures.ts` imports the id that
`record-work.ts` stops exporting, so splitting them would leave a commit
that does not typecheck.

- [ ] **Step 1: Write the failing test**

Append to `describe("the help registry", ...)` in
`webapp/src/help/registry.test.ts`:

```ts
  // The bug this whole change exists to fix: record-work used to start
  // on a hard-coded gig id that only the Playwright fixture created, so
  // on a real account GigDetail rendered "Couldn't open this gig" and
  // every step degraded to prose. A scenario must reach a gig the way a
  // person does.
  it("starts record-work on the gig list, not on a gig id", () => {
    const scenario = getHelpScenario("record-work");
    expect(scenario?.startRoute).toBe("/gigs");
    expect(JSON.stringify(scenario)).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter gigsy-webapp exec vitest run src/help/registry.test.ts`

Expected: FAIL — `startRoute` is
`/gigs/11111111-1111-4111-a111-111111111111`.

- [ ] **Step 3: Rewrite the scenario**

Replace the entire contents of
`webapp/src/help/scenarios/record-work.ts`:

```ts
import { HelpTarget } from "../targets.ts";
import type { HelpScenario } from "../types.ts";

/**
 * The Work card, control by control — status, the clock, breaks, what
 * it's worth, and where actual payments live — on a gig the person
 * picks themselves.
 *
 * It did not always work that way. This scenario used to start on one
 * hard-coded gig id that `webapp/e2e/help/help-fixtures.ts` upserted
 * before every Playwright run. That passed CI and was broken for
 * everybody else: on a real account the gig does not exist,
 * `GigDetail.tsx` takes its `gig.isError` path, and all seven targets
 * below go unresolved and degrade to prose with no spotlight. The
 * fixture still pins a gig, but only so that "the first row" means
 * something fixed in CI — no scenario knows an id any more.
 *
 * So this opens where a person opens a gig, on `/gigs`, and hands the
 * choice back. `find-a-gig`'s header explains why no scenario can point
 * at a particular row — `CardLink`s carry no identifier a HelpTarget
 * can read, and a HelpTarget resolves one static selector with no
 * runtime parameter. A `navigate` step does not need to: it spotlights
 * the LIST, the person taps whichever row is theirs, and the tour
 * follows them onto that gig (types.ts's `NavigateStep`; the tap
 * bubbles to the container, so the tour never learns which row it was).
 *
 * It deliberately does not re-explain search and filters — "Find a gig
 * and open it" is a topic of its own, and the navigate step's copy
 * points at it. Two of the three list states have no row to tap at all,
 * so they end on a terminal step: help must never ask for a tap that
 * cannot happen, and the Work-card steps written after the branch must
 * not run on a screen those two never leave.
 *
 * Every step is a `highlight`, for the reason `create-gig.ts`'s header
 * gives at length: this runs in CI against a shared dev database, and
 * `performAction` really does fill, select and click. That file's form
 * is safe to leave half-filled because nothing writes until Save is
 * pressed; this card has no such backstop — WorkCard.tsx says so
 * plainly, "every control here writes... on change... on blur or
 * Enter", with no Save button at all. A `click` or `input` step here
 * would stamp a start time, change a status, or set an override on a
 * real record the instant the step ran. The navigate step does not
 * break that rule either: tapping a row is a read.
 *
 * Two of the card's controls are not on every gig, which is why the
 * last two branches exist rather than the steps simply being there:
 *
 *   - `gig-expected-pay` renders only when a figure can be computed —
 *     `expectedCents` (lib/gig-pay.ts) is null for a fixed-fee gig with
 *     no amount, and for an hourly one with no rate or no billable
 *     minutes.
 *   - `gig-override` renders only on an hourly gig (`WorkCard.tsx`'s
 *     `isHourly && <HourlyOverride ...>`).
 *
 * Both branches sit AFTER the navigate step, which is the thing the old
 * renderer could not do: `flatten()` resolved every branch against the
 * screen the tour started on, so a branch about a gig the user had not
 * opened yet always measured `/gigs`. TourRenderer now expands one
 * branch at a time as the tour reaches it, matching what
 * `help-runner.ts` always did. Do not move these branches ahead of the
 * navigate step to "be safe" — ahead of it they are wrong.
 *
 * Left out, on purpose:
 *
 *   - The Started/Finished `DateTimeField`s underneath Start and Stop
 *     (`gig-work-start`, `gig-work-end`). They exist to correct a stamp
 *     taken late, which the Start and Stop steps below already say —
 *     covering the same fact twice as two more highlights would be
 *     narrating the screen, not explaining it.
 *   - Additional services (`gig-services`). It is not part of the Work
 *     card — it is its own section between the card and Payments — and
 *     nothing about it is specific to recording work.
 *   - The Edit button onto the Job card's form as a step of its own.
 *     `create-gig` already walks that form field by field. It appears
 *     below only as where the two "this control isn't on this gig"
 *     alternatives send you, because a missing rate or a fixed fee is
 *     something you change on the job, not here.
 *
 * The copy explains what a control is FOR and what it changes
 * elsewhere — same rule as every other scenario in this directory. Two
 * things worth saying that the screen itself doesn't: recording work
 * here never moves the planned date, time or duration on the Job card
 * (gig-pay.ts's own header calls that the whole reason its fields are
 * split the way they are), and an hourly gig's pay line prices actual
 * time worked once you've recorded it, quoting rate × the planned
 * duration until then.
 */
export const recordWork: HelpScenario = {
  id: "record-work",
  title: "Record work on a gig",
  description:
    "Status, the clock, breaks and what it's worth — the half of a gig that changes on the day, one thumb at a time.",
  category: "gigs",
  startRoute: "/gigs",
  // Empirical, not assumed — run and observed. `gigs-showing` holds
  // because `prepareHelpScenario` pins the saved gig-list view back to
  // defaults and upserts one gig unconditionally, so the list always
  // has a row (help-fixtures.ts). `pay-shown` and `hourly-gig` hold
  // because that same fixture gig is hourly, rated and has a duration,
  // and sorts to the top of the default `newest` view — which is the
  // row help-runner.ts's navigate step clicks. If any of those three
  // stops being true, this assertion fails instead of the suite quietly
  // exercising the other alternative.
  expectedCiBranches: ["gigs-showing", "pay-shown", "hourly-gig"],
  steps: [
    {
      action: "branch",
      branches: [
        {
          id: "gigs-showing",
          when: { type: "target-visible", target: HelpTarget.GigList },
          steps: [
            {
              action: "navigate",
              target: HelpTarget.GigList,
              route: "/gigs/:id",
              title: "Open the gig you worked",
              description:
                "Tap whichever row is the job you want to record time against — only you know which one that is. If the list is long, \"Find a gig and open it\" covers the search box and the filters that narrow it. Opening a gig changes nothing; the rest of this walkthrough happens on the screen that opens.",
            },
            {
              action: "highlight",
              target: HelpTarget.GigStatus,
              title: "Status",
              description:
                "lead → confirmed → completed → delivered, and it drives real behaviour, not just a label. A lead never blocks time on your public availability page and never reaches Google Calendar — it's an offer, not a commitment; confirmed does both. Completed is what the dashboard reads as work waiting to be paid. Delivered means the work has been handed over — it's still counted as owed and still blocks the time, exactly like completed, just one step further along. Cancelled pulls the gig out of your calendar, your availability and your reports without deleting the record. Whether it's actually been paid is worked out from the payments recorded below, not set here.",
            },
            {
              action: "highlight",
              target: HelpTarget.GigWorkStartButton,
              title: "Start",
              description:
                "Tap this the moment you actually begin, not before it. It stamps the clock to now, to the minute, and writes only to this gig's actuals — the planned date, time and duration on the Job card above never move, on this tap or anything else on this card. That split is the whole reason the two cards exist: what was agreed stays put, and what happened gets recorded separately.",
            },
            {
              action: "highlight",
              target: HelpTarget.GigWorkStopButton,
              title: "Stop",
              description:
                "Stamps the finish the same way Start stamps the beginning, and stays disabled until there's a start to close. The span between the two — minus whatever you log as a break below — becomes the time this gig actually took, and on an hourly gig that's what gets multiplied by the rate instead of the planned duration.",
            },
            {
              action: "highlight",
              target: HelpTarget.GigBreak,
              title: "Off-time breaks (minutes)",
              description:
                "Minutes to subtract from the span between Start and Stop before anything gets priced — lunch, a delay, anywhere you weren't working. It only changes the figure once both stamps exist; log it early and it's still there, waiting for a span to apply to.",
            },
          ],
        },
        {
          id: "gigs-hidden-by-filters",
          // Reached only when the row wrapper is absent but the filter
          // bar is not — Gigs.tsx renders the "No gigs match these
          // filters" empty state in exactly that combination.
          when: { type: "target-visible", target: HelpTarget.GigFilters },
          steps: [
            {
              action: "highlight",
              target: HelpTarget.GigFiltersToggle,
              title: "Your filters are hiding everything",
              description:
                "You do have gigs — none of them matches what is set right now, so there is no row here to open. Widen it: a date range drops every undated gig, \"hide past gigs\" drops everything before today, and Clear filters puts all of it back at once.",
            },
            {
              action: "highlight",
              target: HelpTarget.GigSearch,
              title: "…and check the search box",
              description:
                "Search narrows the list too, and it survives leaving the screen and coming back, so it is easy to forget something is still in it. Empty it, and once a row appears, start this walkthrough again and tap the gig you want.",
              // Every step below this branch is on a gig's own screen,
              // which this path never reaches.
              end: true,
            },
          ],
        },
        {
          id: "no-gigs-yet",
          // No filter bar at all means the user owns no gigs — the bar
          // is unconditional on `all.length > 0`, so there is nothing to
          // search and no row to tap.
          when: { type: "target-missing", target: HelpTarget.GigFilters },
          steps: [
            {
              action: "highlight",
              target: HelpTarget.GigAdd,
              title: "Nothing to record work against yet",
              description:
                "There are no gigs on this account, so there is nothing here to open. Add one with this button — \"Add a gig by hand\" walks through the form — and everything this walkthrough covers lives on the screen that gig opens on.",
              end: true,
            },
          ],
        },
      ],
    },
    // From here down: reached only by `gigs-showing`, the one
    // alternative above that does not end, and therefore always on a
    // gig's own screen.
    {
      action: "branch",
      branches: [
        {
          id: "pay-shown",
          when: { type: "target-visible", target: HelpTarget.GigExpectedPay },
          steps: [
            {
              action: "highlight",
              target: HelpTarget.GigExpectedPay,
              title: "What it's worth",
              description:
                "Updates the instant anything above it changes. A fixed-fee gig just shows the agreed amount. An hourly one prices the time you've actually recorded once Start and Stop have both landed — before that, it quotes rate × the planned duration from the Job card instead, so there's always a figure here, not a blank.",
            },
          ],
        },
        {
          id: "pay-not-yet",
          when: { type: "target-missing", target: HelpTarget.GigExpectedPay },
          steps: [
            {
              action: "highlight",
              target: HelpTarget.GigEditButton,
              title: "No figure on this one yet",
              description:
                "A line showing what the gig is worth appears above once there's something to work it out from — an agreed amount on a fixed-fee gig, or a rate and a duration on an hourly one. Both live on the job, not here: this button opens the form where you set them, and the figure appears as soon as one of them is there.",
            },
          ],
        },
      ],
    },
    {
      action: "branch",
      branches: [
        {
          id: "hourly-gig",
          when: { type: "target-visible", target: HelpTarget.GigOverride },
          steps: [
            {
              action: "highlight",
              target: HelpTarget.GigOverride,
              title: "Override ($)",
              description:
                "For the hourly gig that didn't bill exactly rate × time — a minimum charged even though it ran short, a discount you gave on the day. An amount typed here replaces the computed figure everywhere pay is read from; clearing it brings the computed figure straight back. It's a statement about what THIS gig earned, which is why it lives here and not on the job that only says how the work is priced.",
            },
          ],
        },
        {
          id: "fixed-fee-gig",
          when: { type: "target-missing", target: HelpTarget.GigOverride },
          steps: [
            {
              action: "highlight",
              target: HelpTarget.GigEditButton,
              title: "This one is a fixed fee",
              description:
                "An hourly gig gets an Override box here, for the shift that didn't bill exactly rate × time — a minimum charged even though it ran short, a discount given on the day. A fixed-fee gig needs none: the agreed amount IS the answer, and you change it on the job form behind this button.",
            },
          ],
        },
      ],
    },
    {
      action: "highlight",
      target: HelpTarget.GigPayments,
      title: "Payments",
      description:
        "Where money you actually receive against this gig gets its own record — an amount, a date, a photo of the proof if you have one, each entry itemised on its own. If you or a client ever need to check exactly what arrived and when, this is where to look.",
    },
  ],
};
```

- [ ] **Step 4: Cut the fixture's import of the scenario's id**

At the top of `webapp/e2e/help/help-fixtures.ts`, delete this line:

```ts
import { RECORD_WORK_GIG_ID } from "../../src/help/scenarios/record-work.ts";
```

- [ ] **Step 5: Delete `ensureAtLeastOneGig` and its title constant**

Delete the whole `SEEDED_GIG_TITLE` const with its doc comment, and the
whole `ensureAtLeastOneGig` function with its doc comment.

- [ ] **Step 6: Rewrite the record-work fixture gig**

Replace `RECORD_WORK_GIG_TITLE` and `ensureRecordWorkGig` with:

```ts
/** The one gig this suite plants, and the id it plants it under.
 *
 *  The id lives HERE and nowhere else. It used to be exported from
 *  `record-work.ts` as that scenario's `startRoute`, which is what made
 *  the scenario pass in CI and fail for every real user: on any account
 *  but this one the gig does not exist, `GigDetail` renders "Couldn't
 *  open this gig", and all seven of the scenario's targets go
 *  unresolved. No scenario knows a gig id any more — `record-work`
 *  reaches a gig the way a person does, through the list.
 *
 *  What the fixture still owes CI is DETERMINISM. The runner performs a
 *  navigate step by clicking the first row (help-runner.ts), so "the
 *  first row" has to mean something fixed. */
const WALKABLE_GIG_ID = "11111111-1111-4111-a111-111111111111";
const WALKABLE_GIG_TITLE = "[help-fixtures] the gig help walks — do not edit";

/**
 * Upsert the one gig `record-work` walks into a known shape, every run.
 *
 * Unconditional, like `resetWorkingWeek` and unlike the seed-if-empty
 * helper this replaced: a PUT with the same id replaces the record
 * (`backend/src/routes/gigs.ts`), so re-running after a previous pass
 * resets it rather than inheriting a start stamp with no stop, or an
 * override somebody's run left behind.
 *
 * Being unconditional also means this guarantees the account owns a gig
 * at all — which is what `ensureAtLeastOneGig` used to be for, and why
 * that function is gone. `find-a-gig`'s `gigs-showing` precondition is
 * met by this same call.
 *
 * Three fields are load-bearing, not decoration:
 *
 *   - `dateTime` FIVE YEARS OUT. The default saved view sorts `newest`
 *     — `dateTime` descending, nulls last (`lib/gig-filters.ts`) — so a
 *     date beyond anything a real account holds puts this gig at the
 *     top of the list, which is the row `help-runner.ts` clicks. Five
 *     years rather than one because the shared dev account holds
 *     several hundred gigs and a year out is a plausible booking.
 *   - `payType: "hourly"` with a rate. `WorkCard`'s override control
 *     renders only on an hourly gig, so a fixed-fee fixture would send
 *     `record-work` down its `fixed-fee-gig` branch and contradict that
 *     scenario's own `expectedCiBranches`.
 *   - `durationMinutes`. `expectedCents` returns null with no billable
 *     minutes to price (`lib/gig-pay.ts`), and a null figure means no
 *     `gig-expected-pay` element and the `pay-not-yet` branch instead.
 *
 * `workStartedAt`/`workEndedAt` stay unset so Start renders enabled and
 * Stop disabled, matching WorkCard.tsx's own guard on a not-yet-started
 * gig — a highlight step never presses either, but there is no reason
 * to start the fixture in a state its own screen would not reach.
 */
async function ensureWalkableGig(
  request: APIRequestContext,
  baseURL: string,
): Promise<void> {
  const login = await request.post(`${baseURL}/api/auth/test-login`, {
    data: { email: "dev@test.local" },
  });
  if (!login.ok()) return; // No test auth here; the spec skips anyway.
  const { accessToken } = (await login.json()) as { accessToken: string };

  await request.put(`${baseURL}/api/gigs/${WALKABLE_GIG_ID}`, {
    headers: { authorization: `Bearer ${accessToken}` },
    data: {
      title: WALKABLE_GIG_TITLE,
      status: "confirmed",
      dateTime: Date.now() + 5 * 365 * 24 * 60 * 60 * 1000,
      durationMinutes: 180,
      payType: "hourly",
      hourlyRateCents: 4500,
      workStartedAt: null,
      workEndedAt: null,
      breakMinutes: null,
      amountOfferedCents: null,
      source: "manual",
    },
  });
}
```

- [ ] **Step 7: Update `prepareHelpScenario` and the stale comments**

In `prepareHelpScenario`, replace the two seeding calls
(`ensureAtLeastOneGig` and `ensureRecordWorkGig`) with one:

```ts
  await ensureWalkableGig(request, baseURL);
```

In that function's doc comment, replace the two paragraphs beginning
"Guarantees the account has a gig at all" and "Pins `record-work`'s own
gig into shape" with one:

```
 * Pins the one gig help walks into shape, unconditionally. That single
 * upsert does two jobs: it guarantees the account owns a gig at all —
 * `find-a-gig`'s `gigs-showing` precondition — and it puts a gig with a
 * known pay shape at the top of the default view, which is the row
 * `record-work`'s navigate step lands the runner on. See
 * `ensureWalkableGig`.
```

In that same comment, "All four resets" becomes "All three resets".

In `waitForGigsToHydrate`'s doc comment, replace the paragraph beginning
"The *other* half of the precondition" with:

```
 * The *other* half of the precondition — that the account has a gig to
 * hydrate at all — is `ensureWalkableGig`'s job, called before this one
 * in `prepareHelpScenario`. This function only ever waits for something
 * the server already has; it does not create anything itself, which is
 * why it still returns immediately, honestly, when the server genuinely
 * has zero gigs (a user other than `dev@test.local`, or similar).
```

- [ ] **Step 8: Confirm nothing still references the deleted names**

```bash
grep -rn "ensureAtLeastOneGig\|SEEDED_GIG_TITLE\|ensureRecordWorkGig\|RECORD_WORK_GIG_ID" webapp/
```

Expected: no matches.

- [ ] **Step 9: Run the help unit suite and typecheck**

```bash
pnpm --filter gigsy-webapp help:validate && pnpm --filter gigsy-webapp typecheck
```

Expected: PASS and exit 0. `help:validate` is `vitest run src/help` —
the whole help unit suite, around twenty seconds because of the
Driver.js tests. It includes `registry.test.ts`'s new assertion and
`validateHelpRegistry` over the real registry.

- [ ] **Step 10: Commit**

```bash
git add webapp/src/help/scenarios/record-work.ts webapp/src/help/registry.test.ts webapp/e2e/help/help-fixtures.ts && git commit -m "fix(help): reach a gig the way a person does, instead of a fixture's id"
```

---

## Task 8: `HelpProvider` tolerates the routes a scenario declares

**Files:**
- Modify: `webapp/src/help/runtime/HelpProvider.tsx`
- Test: `webapp/src/help/runtime/HelpProvider.test.tsx`

- [ ] **Step 1: Write the failing tests**

Append to the existing `describe("HelpProvider", ...)` block in
`webapp/src/help/runtime/HelpProvider.test.tsx`. These use the real
`record-work` from the registry rather than mocking the registry module
— it is the scenario that actually declares a hop, and using it means
this test fails if the declaration is ever dropped:

```ts
  it("does not cancel a tour when the user takes a hop the scenario declared", async () => {
    // record-work's whole shape: start on /gigs, the user taps their
    // own gig, the tour follows. Without this the route-change effect
    // kills the tour on the very hop it exists to make.
    const cancel = vi.fn();
    vi.mocked(runTour).mockResolvedValue(cancel);

    mount("/gigs"); // record-work's startRoute, so no navigation wait.
    await act(async () => {
      await latest!.startScenario("record-work");
    });
    expect(runTour).toHaveBeenCalledTimes(1);

    act(() => navigate!("/gigs/8f14e45f-ceea-467a-9a36-dedd4bea2543"));

    expect(cancel).not.toHaveBeenCalled();
  });

  it("still cancels a tour when the user goes somewhere the scenario never mentioned", async () => {
    const cancel = vi.fn();
    vi.mocked(runTour).mockResolvedValue(cancel);

    mount("/gigs");
    await act(async () => {
      await latest!.startScenario("record-work");
    });

    act(() => navigate!("/settings"));

    expect(cancel).toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter gigsy-webapp exec vitest run src/help/runtime/HelpProvider.test.tsx -t declared`

Expected: FAIL on the first — `cancel` was called, because the effect
compares the new pathname against the single string `/gigs`.

- [ ] **Step 3: Make the provider hold patterns, not one path**

In `webapp/src/help/runtime/HelpProvider.tsx`:

Add the import:

```ts
import { allowedRoutes, matchesRoute } from "../routes.ts";
```

Replace the `expectedRouteRef` declaration and its comment:

```ts
  // The routes this attempt is (or, once running, is expected to stay
  // within): where the scenario starts, plus wherever each of its
  // navigate steps lands. Set as soon as `startScenario` knows them —
  // before it even navigates — so a route-change effect can tell its
  // own startRoute navigation, and a declared mid-tour hop, apart from
  // someone leaving the tour behind.
  const expectedRoutesRef = useRef<string[] | null>(null);
```

In `cancelTour`, replace `expectedRouteRef.current = null;` with:

```ts
    expectedRoutesRef.current = null;
```

In `startScenario`, replace
`expectedRouteRef.current = scenario.startRoute ?? location.pathname;`
with:

```ts
      expectedRoutesRef.current = allowedRoutes(scenario, location.pathname);
```

And replace the route-change effect:

```ts
  // A tour outlives navigation only where the scenario said it would.
  // `allowedRoutes` covers the setup window (including this component's
  // own startRoute navigation, which changes `location.pathname` too)
  // and every hop a navigate step declares, so this fires only for a
  // route change that leaves the scenario behind.
  useEffect(() => {
    const allowed = expectedRoutesRef.current;
    if (
      allowed !== null &&
      !allowed.some((pattern) => matchesRoute(pattern, location.pathname))
    ) {
      cancelTour();
    }
  }, [location.pathname, cancelTour]);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter gigsy-webapp exec vitest run src/help/runtime/HelpProvider.test.tsx`

Expected: PASS, all tests in the file.

- [ ] **Step 5: Commit**

```bash
git add webapp/src/help/runtime/HelpProvider.tsx webapp/src/help/runtime/HelpProvider.test.tsx && git commit -m "feat(help): keep a tour alive across the route changes its scenario declares"
```

---

## Task 9: Documentation

**Files:**
- Modify: `docs/help/README.md`
- Modify: `docs/gigsy-executable-help-implementation-spec.md`

- [ ] **Step 1: Replace README §2's post-interaction-branch warning**

In `docs/help/README.md`, find the paragraph beginning **"That is true
of targets. It is NOT true of branches — and the two adapters differ."**
and replace it, and the two paragraphs after it (down to and including
the one beginning "So: keep branch steps ahead of the first user
interaction"), with:

```markdown
**Branches resolve where the tour reaches them — in both adapters.**
This was not always so. `TourRenderer.runTour` used to flatten the whole
scenario before `tour.drive()`, resolving every branch against the DOM
as it looked when the tour started, while `help-runner.ts` walked the
list in order and resolved each branch at the moment it got there. A
branch placed after a click, `input`, `select` or `navigate` step
therefore passed `help:test` and picked the wrong alternative for every
real user. The renderer now expands one branch at a time as the tour
approaches it, so the two agree and a branch may sit anywhere.

What has NOT changed is that a branch must be answerable when it is
reached. A condition about a control on a screen the user has not opened
yet is still unanswerable — put the `navigate` step that opens that
screen ahead of the branch, which is what `record-work` does.
```

**Also in §2 and §6, `flatten()` no longer exists.** Task 5 deleted it —
`runTour` resolves branches through `expandBranch` now, and nothing else
called it. Both sections tell the reader to "fix `flatten()` first"
before shipping a post-interaction branch; that instruction is stale in
two ways (the function is gone, and the thing it was meant to fix is
done). Replace every mention with `expandBranch`, and make sure no
sentence still implies the renderer resolves branches up front.

- [ ] **Step 2: Add the two new §2 notes**

Immediately after the text you just inserted, add:

```markdown
**A tour can follow the user to another screen — say so with a
`navigate` step.** Its `target` is a CONTAINER of choices, not one
control: the tour spotlights the whole list, the person taps whichever
row is theirs, and the tap bubbles to the container, so the scenario
never learns which one. Its `route` is the pattern the tap must land on
(`/gigs/:id`; one segment per `:param`, see `webapp/src/help/routes.ts`)
— `HelpProvider` reads it to tell the declared hop apart from someone
walking out on the tour, and `help-runner.ts` waits for the URL to match
it. The runner clicks the first `a[href]` inside the container, because
"which row is yours" is precisely what a scenario refuses to decide.

**A branch alternative that cannot continue must end on a terminal
step.** Steps written after a branch step run whichever alternative was
taken, so a `no-gigs-yet` path would otherwise fall through into steps
about a screen it never reached. Mark its last step `end: true` and the
tour stops there. The flip side is that everything after a branch step
belongs, by construction, to whichever alternative did *not* end — say
so in a comment, as `record-work` does.
```

- [ ] **Step 3: Replace §6's fourth gap**

Find the paragraph beginning **"**A branch placed after an
interaction.** See §2"** and replace it with:

```markdown
**Which row a person would actually tap.** A `navigate` step's
destination is asserted — the runner clicks the first row and waits for
the route — but the runner's choice is a stand-in, not the user's. A
scenario whose copy says "tap the gig you worked" is never checked
against whether the row a human would pick behaves the same way. That is
what the two branches at the end of `record-work` exist for, and running
it by hand on a gig the fixture did not create is the only thing that
proves them.
```

- [ ] **Step 4: Update the implementation spec's model section**

In `docs/gigsy-executable-help-implementation-spec.md`, find the comment
around line 403 beginning `/** No NavigateStep:` together with the
`HelpStep` union below it, and replace both with the union, the
`HelpStepBase` interface and the `NavigateStep` interface exactly as
they now read in `webapp/src/help/types.ts` — copy them from that file
so the two cannot drift.

Then add this paragraph directly under that code block:

```markdown
Mid-tour navigation and lazy branch resolution were added in
`docs/superpowers/specs/2026-08-26-help-mid-tour-navigation-design.md`,
which records why `startRoute` alone could not serve `record-work`.
```

- [ ] **Step 5: Verify the docs reference nothing that no longer exists**

```bash
grep -rn "ensureAtLeastOneGig\|RECORD_WORK_GIG_ID\|No NavigateStep" docs/ webapp/
```

Expected: matches only inside `docs/superpowers/specs/` and
`docs/superpowers/plans/`, which are historical records of decisions and
are not updated.

- [ ] **Step 6: Commit**

```bash
git add docs/help/README.md docs/gigsy-executable-help-implementation-spec.md && git commit -m "docs(help): document navigate steps, terminal steps and lazy branches"
```

---

## Task 10: Verify against a local stack

**Files:** none — this is the verification gate.

No claim of completeness before this task's output has been read. Green
is not the same as "ran".

- [ ] **Step 1: Bring up the hermetic local stack**

Two shells, matching `docs/help/README.md` §5 and the `webapp-e2e-full`
job in `.github/workflows/deploy.yml`:

```bash
cd backend && cp .dev.vars.example .dev.vars && pnpm exec wrangler d1 migrations apply gigsy-db --local && pnpm exec wrangler dev --port 8787
```

```bash
cd webapp && pnpm dev --port 5192 --host 127.0.0.1
```

- [ ] **Step 2: Run the unit suites**

```bash
pnpm --filter gigsy-webapp typecheck && pnpm --filter gigsy-webapp test
```

Expected: exit 0 for both.

- [ ] **Step 3: Run the help scenario suite**

```bash
E2E_BASE_URL=http://127.0.0.1:5192 E2E_REQUIRE_AUTH=1 pnpm --filter gigsy-webapp help:test
```

Expected: every scenario passes, and `help: record-work` in particular
reports `branchesTaken` equal to
`["gigs-showing", "pay-shown", "hourly-gig"]`.

If that assertion fails, README §5 governs: diagnose, do not edit the
declaration to match what happened. The three most likely causes, in
order — (a) the fixture gig is not sorting first, so the runner opened
somebody else's gig: check `dateTime` in `ensureWalkableGig` against the
newest gig in the account; (b) `resetGigListView` did not run, or the
default sort is no longer `newest`; (c) a genuine race, in which case
the fix is stability margin in `resolveBranch`, not a looser assertion.

- [ ] **Step 4: Run it a second time**

```bash
E2E_BASE_URL=http://127.0.0.1:5192 E2E_REQUIRE_AUTH=1 pnpm --filter gigsy-webapp help:test
```

Expected: identical result. A scenario that passes on the first run of a
session and fails on the second means a precondition is not being pinned
— `ensureWalkableGig` is unconditional precisely so a previous run's
work stamps cannot survive into this one.

- [ ] **Step 5: Run the ordinary E2E suite**

```bash
E2E_BASE_URL=http://127.0.0.1:5192 E2E_REQUIRE_AUTH=1 pnpm --filter gigsy-webapp test:e2e
```

Expected: pass. `gig-list.spec.ts` shares the saved view this fixture
resets, so this is where an interaction between them would show.

- [ ] **Step 6: Run the tour by hand — the part no suite can see**

```bash
pnpm --filter gigsy-webapp dev
```

Open Settings → Help → "Record work on a gig" and walk it, twice:

1. **On an hourly gig with a rate.** Confirm the spotlight lands on the
   list, that tapping your own row carries the tour onto that gig
   instead of showing "This help step is currently unavailable", and
   that the Override and "What it's worth" steps both appear.
2. **On a fixed-fee gig.** Confirm you get the `fixed-fee-gig`
   alternative pointing at the Edit button, and that the tour still ends
   on Payments.

Also check, per README §6, that the copy still reads as a walkthrough,
and that the progress counter growing once mid-tour — a branch expanding
is what does it — is not confusing enough to warrant hiding.

- [ ] **Step 7: Report**

State what was run and what it said. If any step was skipped, say which
and why.

---

## Notes for whoever executes this

- `pnpm --filter gigsy-webapp typecheck` runs `tsc -b`. A bare
  `tsc --noEmit` in this package always exits 0 and proves nothing.
- `help:validate` is `vitest run src/help` — the whole help unit suite,
  around twenty seconds, not just the validator.
- `help:test` refuses to run against anything but localhost, by design:
  these scenarios write settings, and Playwright's default target here
  is the production deployment sharing production D1.
- Nothing in this plan is committed, merged or pushed without the user
  saying so.
