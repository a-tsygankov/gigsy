# Gigsy Executable Help — Implementation Specification

**Status:** ready to implement · **Slots as:** Phase 13 in `docs/plan.md` §13

This document is an implementation specification for an AI coding agent
working on `a-tsygankov/gigsy`. It has been audited against the repository
at commit `428703a` (branch `dev-38`); §2 records the facts that constrain
the design, and every one of them was verified in the code rather than
assumed.

Stages here are numbered **PR 1–5**, deliberately not "Phase N" — the
project already numbers phases globally and is at Phase 12. The feature as
a whole is Phase 13.

---

## 1. Purpose

Add an interactive, executable help system that answers questions like:

- How do I open Settings?
- How do I configure notifications?
- How do I configure working days and hours?
- How do I set up email capture?
- How do I install Gigsy on my phone or desktop?

The long-term goal is to stop maintaining three unrelated artifacts —
in-app help, UI tests, and written documentation — that describe the same
workflow and drift apart. Instead there is one machine-readable
`HelpScenario` model with adapters:

```text
                     HelpScenario
                          |
             +------------+-------------+
             |            |             |
             v            v             v
        Interactive    Playwright    Generated docs
           tour         validator     (deferred, PR 5)
```

The central design goal:

> Help should behave like executable product knowledge: easy for users to
> follow, easy for developers to validate, and difficult for UI changes to
> silently make obsolete.

The emphasis is on **silently**. Most of the design decisions below exist
to convert a silent staleness into a loud CI failure, because this
repository has already been bitten by the opposite (§2.6).

---

## 2. Verified repository context

These are facts about the code as it stands. They are the reason several
obvious-looking designs do not work here.

### 2.1 Toggle test IDs point at an invisible element

`Toggle` (`webapp/src/components/Toggle.tsx`) puts `data-testid` on a real
`<input type="checkbox">` that is `peer sr-only` — 1×1 pixel. The switch
you can see is a sibling `<span aria-hidden="true">` inside a wrapping
`<label>`.

Two consequences, both fatal to a naive implementation:

- A tour that highlights `[data-testid="toggle-day-0"]` draws a spotlight
  on a 1×1 invisible box. The user sees a highlight over nothing.
- `page.getByTestId("toggle-day-0").click()` **passes without proving
  anything a user could do.** `webapp/e2e/settings.spec.ts` (the
  `paintedSwitch` helper, lines 57–99) exists precisely because of this
  and says so: clicking the testid "would pass either way". A real bug —
  every toggle in the app being untappable — hid behind that for months.

Affected targets: `toggle-prefix`, `toggle-day-0`…`toggle-day-6`,
`toggle-avail-calendar`, `toggle-notifications`, `toggle-stale-leads`,
`toggle-unpaid`, `toggle-default-reminder`.

**`push-toggle` is not one of them.** Despite the name it is a `<Button>`
(`Settings.tsx:108`), not a `Toggle`. This is exactly why the design below
records a target's kind explicitly instead of inferring it from a `toggle-`
prefix — and why `toggle-prefix` (a *calendar title prefix* switch,
`CalendarSection.tsx:82`) makes prefix inference worse than useless.

### 2.2 `e2e/` is type-checked by nothing

`tsconfig.app.json` includes `src` only. `tsconfig.node.json` includes
`vite.config.ts`, `vitest.config.ts`, `playwright.config.ts` only. So
`pnpm typecheck` (`tsc -b --noEmit`) never sees `webapp/e2e`.

A Playwright runner importing the shared model would therefore get zero
type checking, which defeats the entire premise of one typed model with
several adapters. PR 3 fixes this.

### 2.3 Playwright's default target is production

`webapp/playwright.config.ts:6`:

```ts
const baseURL = process.env["E2E_BASE_URL"] ?? "https://gigsy-webapp.pages.dev";
```

with `workers: 1` and the comment "serialise — tests will share the prod
D1". Help scenarios *mutate settings* (toggling working days is one of the
five MVP scenarios). Running them against the default target would write to
the shared production database. `help:test` must refuse to run without an
explicit local target (§8.4).

### 2.4 One Playwright project, phone-shaped

The only project is `chromium` at `devices["Pixel 7"]` — mobile viewport,
touch, mobile UA. Desktop install instructions cannot be validated at a
desktop viewport without adding a project, and any screenshots would be
phone-shaped. This is why desktop install steps are external instructions
(§6.5) rather than executable ones.

### 2.5 `testDir` is `./e2e`, so new specs join the existing suite

Anything matching `e2e/**/*.spec.ts` runs under `pnpm test:e2e`. Help specs
must be separated deliberately (§8.3) or the Definition of Done's "help
scenario tests run separately from existing E2E tests" is false on day one.

### 2.6 CI has no single test workflow, and has been fooled before

`.github/workflows/deploy.yml` has six jobs. The relevant ones:

- `webapp-e2e-preview` — runs against a Pages preview whose `/api` proxies
  to the **production** worker, where the test-auth bypass is off. Every
  signed-in spec skips here by design.
- `webapp-e2e-full` — a hermetic local stack (`.dev.vars` + local D1
  migration + `wrangler dev` + `vite` + a check that `testAuthEnabled` is
  true), with `E2E_REQUIRE_AUTH=1` turning a skip into a failure.

The comment at `deploy.yml:150–154` records why `webapp-e2e-full` exists:
the preview job "reported green while skipping 12 of 20 tests — the
authenticated half of the app had no CI coverage at all."

Help scenarios need authentication, so they belong in `webapp-e2e-full`.
More importantly, that history is the reason §7.3 and §8.5 make branch
selection an asserted fact rather than a silent runtime choice.

### 2.7 Design system constraints

`docs/design-system.md`: Gigsy has **no icon set** — no icon font, no SVG
sprite, no icon library. Text and Unicode characters stand in. The header
at 375px already carries wordmark, screen title, sync chip, and the
Settings link; the tab bar is at its five-tab practical limit. Adding a
sixth navigation element is not free.

Hence: the help launcher is a section on the Settings screen (§7.2), and
Driver.js must be restyled to design tokens (§7.4).

**One correction to that document, found during implementation:** it
claims no dark values exist in the codebase. They do —
`webapp/src/styles/tokens/colors.css:70` defines `:root[data-theme="dark"]`,
`index.html` stamps the theme before first paint, and
`AppearanceSection.tsx` exposes the control. Any CSS this work adds must
use the semantic tokens and be checked in both themes; hardcoded
light-mode values render as a glaring white card in dark mode. Trust the
code over the document here.

### 2.8 Vitest runs in Node, with no DOM

`vitest.config.ts` sets `include: ["src/**/*.test.{ts,tsx}"]` and nothing
else; existing tests are pure logic. Testing the DOM target resolver
requires adding `jsdom` and opting in per file (§5.4).

### 2.9 Selector inventory

Every `data-testid` referenced by the MVP scenarios already exists:
`settings-link`, `settings-notifications`, `push-toggle`,
`push-unavailable`, `settings-capture`, `capture-address`,
`capture-address-value`, `capture-unconfigured`, `settings-availability`,
`avail-working-week`, `toggle-day-0`…`6`, `start-day-N`, `end-day-N`,
`tab-bar`, `test-signin`.

One new ID is introduced by this work: `settings-help`.

`settings-link` is **conditionally rendered** — `AppHeader.tsx:43` hides it
when `pathname === "/settings"`. A scenario starting on `/settings` must
not reference it.

---

## 3. Architectural principles

**3.1 `HelpScenario` is the source of truth.** Not Markdown, not
screenshots, not Driver.js config, not Playwright tests. Adapters consume
the model; none of them owns it.

**3.2 Do not rewrite existing E2E tests.** They prove application
behaviour and carry regression coverage. Help specs prove documented
workflows remain executable. Overlap between the two is fine — the
responsibilities differ.

**3.3 Reuse the existing `data-testid` system.** Never introduce
positional selectors (`div:nth-child(3) > button`) or generated class
names. Where a meaningful target lacks a stable identifier, add one.

**3.4 A target's interaction surface is part of the model.** §2.1 is not
an edge case; it covers most interactive controls in the app. The model
records *how* to reach a target, once, for every adapter.

**3.5 Keep the DSL small.** Support only what the five MVP scenarios need.
This is not a workflow engine. Add operations when a real scenario
requires one, not before.

**3.6 In-app help and browser/OS help are different things.** A tour can
highlight DOM that Gigsy owns. It cannot highlight Chrome's install
button, Safari's Share menu, or iOS "Add to Home Screen". Those are
explanatory steps, explicitly modelled as external.

**3.7 Silence is the enemy.** Any place where the system could do nothing
and still report success must be closed: a scenario that skipped, a branch
that never ran, a target that resolved to something invisible. Production
UX degrades gracefully; development and CI fail loudly. This asymmetry is
deliberate (§10).

**3.8 AI is not the source of truth.** Later phases may propose
descriptions. Proposals are reviewed and still validated by deterministic
selectors under Playwright.

---

## 4. Target architecture

```text
webapp/src/help/
├── targets.ts            HelpTarget + kind + both resolvers
├── types.ts              HelpScenario / HelpStep / HelpCondition
├── validate.ts           structural validation, browser-free
├── registry.ts           the single discovery mechanism
├── environment.ts        install-variant detection (PR 4)
├── scenarios/
│   ├── open-settings.ts
│   ├── notifications.ts
│   ├── working-hours.ts
│   ├── email-capture.ts
│   └── install-app.ts
└── runtime/
    ├── HelpProvider.tsx
    ├── HelpSection.tsx   the launcher, lives on Settings
    ├── HelpMenu.tsx
    └── TourRenderer.ts

webapp/e2e/help/
├── help-runner.ts        executes a scenario, returns a trace
├── help-fixtures.ts      auth + navigation setup
└── scenarios.spec.ts     one test per scenario

webapp/tsconfig.e2e.json  so the above is actually type-checked
```

Filenames may be adjusted to match conventions, but preserve the
separation of domain model, scenario definitions, interactive renderer,
and Playwright adapter.

---

## 5. PR 1 — Domain model

### 5.1 Targets carry a kind

`webapp/src/help/targets.ts`.

```ts
/** How a target's interactive surface relates to its test ID.
 *
 *  `element`  the tagged node is the thing itself.
 *  `switch`   the tag sits on a `peer sr-only` input (1×1); the operable
 *             surface is the painted span inside the wrapping label.
 *             See components/Toggle.tsx and the paintedSwitch helper in
 *             e2e/settings.spec.ts — clicking the tagged input directly
 *             passes a test while proving nothing a user could do.
 */
export type HelpTargetKind = "element" | "switch";

export interface HelpTarget {
  readonly id: string;
  readonly kind: HelpTargetKind;
}

const element = (id: string): HelpTarget => ({ id, kind: "element" });
const painted = (id: string): HelpTarget => ({ id, kind: "switch" });

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

/** Working-hours day switches are generated, so the target is too. */
export const dayToggle = (i: WeekdayIndex): HelpTarget =>
  painted(`toggle-day-${i}`);
```

Do not migrate every `data-testid` in the app to this table. Start with
the targets the scenarios use. When editing a component that owns one,
prefer `data-testid={HelpTarget.SettingsHelp.id}` over a duplicated
literal; existing tests may keep using string literals.

**Prefix inference is forbidden.** A target's kind is declared, never
derived from its name. `push-toggle` is an element and `toggle-prefix` is
a switch; any rule based on the name gets both wrong.

### 5.2 Two resolvers, one kind

Both adapters need to reach the same surface, but one needs a DOM node and
the other a Playwright locator. They share the *kind*, not an
implementation.

```ts
/** CSS for Playwright. This is the locator e2e/settings.spec.ts already
 *  proves correct against the real component. */
export function targetSelector(t: HelpTarget): string {
  return t.kind === "switch"
    ? `label:has([data-testid="${t.id}"]) span[aria-hidden="true"]`
    : `[data-testid="${t.id}"]`;
}

/** DOM for the tour. Walks rather than using `:has()`, so the spotlight
 *  does not depend on selector support on the oldest iOS Safari we care
 *  about. */
export function resolveTarget(t: HelpTarget): HTMLElement | null {
  const tagged = document.querySelector<HTMLElement>(
    `[data-testid="${CSS.escape(t.id)}"]`,
  );
  if (tagged === null) return null;
  if (t.kind === "element") return tagged;
  return (
    tagged.closest("label")?.querySelector<HTMLElement>(
      'span[aria-hidden="true"]',
    ) ?? null
  );
}
```

Adding a third kind means editing one file. That is the point.

### 5.3 Scenario model

`webapp/src/help/types.ts`.

```ts
export type HelpScenarioId = string;

export type HelpCategory =
  | "getting-started"
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
   *  starts — which is also how "Open Settings" works when help is
   *  opened from Settings, since AppHeader hides `settings-link` there. */
  startRoute?: string;
  steps: HelpStep[];
  /** Environment-selected alternatives. Only installation uses these,
   *  and only non-executable scenarios may have them. */
  variants?: HelpVariant[];
  /** Branch ids this scenario is expected to take under the hermetic CI
   *  stack, in order. Asserted by the suite: an environment change that
   *  flips a branch becomes a failure rather than a silent change in
   *  what got tested. See §8.5. */
  expectedCiBranches?: string[];
  /** Set when the scenario cannot execute under Playwright at all —
   *  install instructions, for instance. Validated structurally, never
   *  run. */
  executable?: false;
}

/** No NavigateStep: `startRoute` covers every scenario we have, and
 *  mid-tour navigation would need a renderer that survives the remount
 *  it causes. Add it when something actually needs it (§3.5). */
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
  /** Never a real address, name, or token — see §11. */
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
 *  explained-as-unavailable, capture configured or not. Help must not
 *  tell someone to click a control that is intentionally absent. */
export interface BranchStep {
  action: "branch";
  /** Ordered. The first branch whose condition holds is taken. If none
   *  holds, that is a failure, not a no-op. */
  branches: HelpBranch[];
}

export interface HelpBranch {
  /** Stable and unique within the scenario. Appears in run traces and
   *  in `expectedCiBranches`, so renaming one is a visible change. */
  id: string;
  when: HelpCondition;
  /** Never contains a nested BranchStep — enforced by the validator. */
  steps: HelpStep[];
}

/** Named and deterministic. Deliberately not an expression language. */
export type HelpCondition =
  | { type: "target-visible"; target: HelpTarget }
  | { type: "target-missing"; target: HelpTarget };

/** Browser and OS operations Gigsy cannot drive or highlight. */
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

No `capture?: boolean` field yet. Screenshot generation is PR 5; adding
the field then is trivial, and carrying it now means shipping a field
nothing reads.

**Unknown targets are a compile error.** Because a step holds a
`HelpTarget` object rather than a string, a target that does not exist
cannot be referenced — TypeScript rejects it. This is strictly better than
validating string IDs at run time, and it is why §9's validator does not
list "unknown target" as a check. Whether a target still exists *in the
DOM* is not a static question; that is what PR 3 is for.

### 5.4 Validator and unit tests

`webapp/src/help/validate.ts` exports `validateHelpRegistry(scenarios)`,
returning a list of problems. It runs without a browser, and both the unit
suite and `help:validate` call it. Checks:

- duplicate scenario id
- scenario with neither steps nor variants
- scenario with *both* steps and variants — the model treats them as
  alternatives, and nothing downstream knows which to render
- duplicate branch id within a scenario
- branch with zero steps
- a `BranchStep` nested inside a branch
- `external` step with an empty description
- `expectedCiBranches` naming a branch id that does not exist
- a non-`executable` scenario containing executable steps, or an
  `executable` scenario whose every path is external
- variants on an `executable` scenario
- duplicate variant environment, or a variant with zero steps
- no `fallback` variant — a wrong user-agent guess must never leave
  someone with nothing

Unit tests (`src/help/*.test.ts`) cover the validator, registry lookup,
and — with `jsdom` — that `resolveTarget` reaches the painted span for a
`switch` target and the tagged node for an `element`. §2.8: vitest runs in
Node with no DOM, so add `jsdom` as a devDependency and opt in per file:

```ts
/** @vitest-environment jsdom */
```

Leave the global vitest environment as Node. One DOM test file does not
justify slowing every other suite.

### 5.5 Registry

`webapp/src/help/registry.ts` is the single discovery mechanism for the
runtime UI, the Playwright suite, and (later) the doc generator.

```ts
export const helpScenarios: HelpScenario[] = [ /* … */ ];

export function getHelpScenario(id: string): HelpScenario | undefined {
  return helpScenarios.find((s) => s.id === id);
}

export const executableHelpScenarios = helpScenarios.filter(
  (s) => s.executable !== false,
);
```

### PR 1 acceptance

- `pnpm typecheck`, `pnpm test`, `pnpm test:e2e` all green.
- No user-visible change whatsoever.
- Registry holds at least `open-settings`.
- Scenario files contain no DOM access and no Playwright imports.
- No Driver.js dependency yet.

---

## 6. Scenarios (PR 2 and PR 4)

Five scenarios, chosen because they cover five different problem classes.
Do not add more until these prove the architecture.

| Scenario | Class | Executable |
|---|---|---|
| Open Settings | simple navigation | yes |
| Configure notifications | conditional setting | yes, one branch |
| Configure working days/hours | interactive multi-step | yes |
| Set up email capture | state-dependent | yes, one branch |
| Install Gigsy | browser/OS external | no |

### 6.1 Open Settings

`startRoute: "/"`, one `click` on `HelpTarget.SettingsLink`. The lowest-risk
proof that the model, the tour, and the runner agree.

### 6.2 Configure notifications

Navigate to `/settings`, highlight `SettingsNotifications`, then branch:

- `push-available` — when `PushToggle` is visible: click it.
- `push-blocked` — when `PushUnavailable` is visible: highlight it and
  explain that the copy on screen says what to do about it.

`expectedCiBranches: ["push-blocked"]`. Headless Chromium cannot grant
notification permission and the local worker has no VAPID config, so CI
takes the blocked branch — always. Declaring it is the point: the tour
still covers the useful path for a real user, and a CI environment that
starts producing `push-available` fails loudly rather than quietly
changing what is under test.

### 6.3 Configure working days and hours

Navigate to `/settings`, highlight `AvailWorkingWeek`, click
`dayToggle(0)`, then select a start time on that day. This is the scenario
that would have been a false pass without §5.1, and the reason the kind
system exists — keep it in the MVP for exactly that reason.

Do not hard-code assumptions about all seven days.

### 6.4 Set up email capture

Navigate to `/settings`, highlight `SettingsCapture`, then branch:

- `capture-configured` — `CaptureAddress` visible: highlight
  `CaptureAddressValue` and explain forwarding.
- `capture-unconfigured` — `CaptureUnconfigured` visible: say capture is
  not switched on for this deployment.

Set `expectedCiBranches` to whichever branch the hermetic stack actually
produces. Determine it by running the suite, not by guessing.

### 6.5 Install Gigsy

`executable: false`. The app is a PWA but installation lives entirely in
browser and OS chrome, which Gigsy cannot highlight or drive (§3.6).

Variants: `ios-safari`, `android-chrome`, `desktop-chrome`, `desktop-edge`,
`fallback`. Each is a list of `external` steps.

`webapp/src/help/environment.ts` holds `detectHelpEnvironment(userAgent)`,
isolated so it is unit-testable. The `HelpEnvironment` type itself lives
in `types.ts`, because scenarios reference it.

Detection order matters: Edge's user agent contains "Chrome", and every
iOS browser is WebKit installing through the same Share sheet, so the
brand distinction there is noise.

The menu must let the user pick a different variant manually, and an
unrecognised agent resolves to `fallback` rather than a guess. A wrong
guess would otherwise make the one piece of help someone needs *before*
they have the app unusable.

Playwright validates structure only: every variant exists, every external
step has a description, no variant claims executable steps.

---

## 7. PR 2 — Interactive help

### 7.1 HelpProvider

`webapp/src/help/runtime/HelpProvider.tsx`:

```ts
interface HelpContextValue {
  isOpen: boolean;
  openHelp(): void;
  closeHelp(): void;
  startScenario(id: HelpScenarioId): Promise<void>;
}
```

Responsibilities: track the active scenario, navigate when a step requires
it, drive the renderer, and cancel cleanly. Mount it inside `App.tsx` so
`startScenario` can route.

### 7.2 The launcher lives on Settings

§2.7: the 375px header and the five-tab bar are both full, and Gigsy has
no icon set to shrink an entry point into.

Add `HelpSection` — a `SettingGroup` titled "Help" with
`data-testid="settings-help"` — to the Settings screen, above `Account`.
It owns placement and nothing else: the list itself is `HelpMenu`, which
renders scenarios grouped by category with a text search over title and
description, and calls `startScenario` on selection.

The split is what makes a second entry point additive later — a header
door would mount the same `HelpMenu` without duplicating it.

Do not build a documentation portal inside it. Do not redesign navigation.

The cost is one extra tap and that help is discovered where people already
look for configuration. If a header entry point is wanted later, it is
additive: the section stays, the header gains a second door to the same
menu.

### 7.3 TourRenderer

`webapp/src/help/runtime/TourRenderer.ts` maps steps onto Driver.js:

```text
highlight → spotlight the element, show the popover
click     → spotlight, instruct, advance when the expected state appears
navigate  → route, wait for the destination, continue
branch    → evaluate conditions against the live DOM, take the first hit
external  → popover with no spotlight
```

**The user performs the click.** The tour must not silently perform
business operations on their behalf — toggling a working day changes what
an agency sees on a public page. Say "Click Notifications" and continue
when the expected UI appears. Do not have the engine click for them. This
is help, not macro automation.

Targets resolve through `resolveTarget` (§5.2) — never through a raw
`data-testid` query, or the working-hours tour spotlights a 1×1 box.

**Resolve each target when its step is entered, not all of them up
front.** A step's target may not exist until an earlier step creates it:
`AvailabilitySection.tsx` renders `start-day-N` only once day N is
switched on, so resolving the whole scenario before `drive()` makes the
working-hours tour unrunnable for exactly the person it is written for.

**Advance a click step from the control, not from the paint.** For a
`switch` target the resolved element is the aria-hidden span, but the
same toggle can be operated by its separate day-name `<label htmlFor>`
or by focusing the `sr-only` input and pressing Space — neither of which
sends an event through the span. Listen where the state actually
changes, or a keyboard user cannot complete a click step at all, and a
mouse user gets stranded on a step whose data has already changed.

**Gate the advance on the active step.** Highlighting a container makes
everything inside it interactive (Driver.js sets `pointer-events: auto`
on the active element's descendants), so a listener registered up front
can be consumed by a click meant for a different step.

**Wait generously before the first user interaction, briefly after it.**
Two different things create DOM mid-tour, and they need different
patience. After a user action the target appears fast, so a short wait
keeps a genuinely broken scenario from making someone stare at a blank
popover. Before any interaction, though, the target may still be waiting
on data: the provider waits for the *route* to settle, not the query, and
`Settings.tsx` renders whole sections only once settings load. A short
wait on step 0 reports "unavailable" on a healthy app whenever the
network is slow — and then works on retry, because the query has cached,
which makes it an intermittent first-run failure.

Branch steps are not the fix for this. They exist for states that are all
legitimate, not for waiting, and a scenario like working-hours has
nothing conditional in it.

**Failure is graceful.** A missing target ends the scenario with "This
help step is currently unavailable" and a way back to the menu. It never
throws into the app, and it logs enough to debug. Contrast with §8, where
the same condition fails a test — see §10.

If a branch matches nothing at run time, treat it as a missing target:
end gracefully rather than continuing into steps whose preconditions do
not hold.

### 7.4 Driver.js, restyled

Add `driver.js` to `webapp` only, `import()`ed lazily so it stays out of
the initial bundle (§12). Set `popoverClass` to a Gigsy class and style
the popover, its buttons, and its arrow from design tokens —
`docs/design-system.md` allows no third-party visual language, and an
unstyled Driver.js popover reads as another product's UI dropped into the
screen.

Restyle at minimum: popover surface and radius (match `Card`), button
treatment (match `Button` variants), typography (system stack), the
spotlight outline, **and the close button** — on a click step, which
shows no Next, that × is the only exit, and Driver.js ships it as
`all: unset; color: #d2d2d2`, well under the 3:1 contrast floor and with
no focus ring.

Use the semantic tokens from `src/styles/tokens/colors.css`, not hex
literals, and check both themes (see §2.7). Leave the arrow alone: a rule
on `.driver-popover-arrow` outweighs Driver.js's own side-classes, which
set three borders transparent to form the triangle, and turns it into a
solid block.

### 7.5 Accessibility

Non-negotiable (`docs/design-system.md` and §22 of the original spec):

- the Settings help section is reachable and operable by keyboard;
- the menu uses semantic buttons and a real text input;
- the tour is cancellable from the keyboard;
- focus is never permanently trapped, including when a scenario ends
  early on a missing target;
- highlighting does not rely on colour alone;
- step descriptions are exposed to assistive technology where Driver.js
  supports it.

User-facing copy comes from accessible labels and visible text, never from
test IDs. `data-testid` is an implementation identifier, not documentation.

### PR 2 acceptance

- A Help section is visible on Settings and keyboard-operable.
- "Open Settings" runs, spotlights the real control, and completes.
- A working-hours step spotlights the **painted switch**, verified by eye
  — this is the regression §2.1 predicts.
- Cancelling restores normal application state.
- A deliberately broken target ends the tour gracefully.
- With help inactive, application behaviour is unchanged.
- Driver.js is absent from the initial bundle.

---

## 8. PR 3 — Playwright validation

### 8.1 The runner executes; the tour instructs

Unlike the interactive renderer, the Playwright adapter performs actions
itself.

`webapp/e2e/help/help-runner.ts`:

```ts
export interface HelpRunTrace {
  scenarioId: HelpScenarioId;
  /** Branch ids taken, in order. Asserted by the suite (§8.5). */
  branchesTaken: string[];
  stepsRun: number;
}

export async function runHelpScenario(
  page: Page,
  scenario: HelpScenario,
): Promise<HelpRunTrace>;
```

Step mapping, all through `targetSelector` (§5.2) so switches resolve to
the painted surface:

```ts
const locator = (t: HelpTarget) => page.locator(targetSelector(t));

// `startRoute` is handled by the fixture, before any step runs.
case "highlight": await expect(locator(step.target)).toBeVisible(); break;
case "click":     await locator(step.target).click(); break;
case "input":     await locator(step.target).fill(step.value ?? ""); break;
case "select":    await locator(step.target).selectOption(step.value ?? ""); break;
case "branch":    /* §8.2 */ break;
case "external":  /* metadata only — browser UI is not executable */ break;
```

Never `page.waitForTimeout`. Wait on visible state, URL, or a locator.

### 8.2 Branch resolution fails loudly

Evaluate each branch's condition in order and take the first that holds.
If none holds, **throw** — do not fall through, and do not treat "no
branch matched" as "nothing to do". A scenario whose branches have all
stopped matching is exactly the stale help this system exists to catch.

Record the taken branch id in the trace.

### 8.3 A separate Playwright project, not a separate config

§2.5: `e2e/help/*.spec.ts` would otherwise join `pnpm test:e2e`. Add a
second project to the existing `playwright.config.ts`:

```ts
projects: [
  { name: "chromium", use: { ...devices["Pixel 7"] },
    testIgnore: /help\// },
  { name: "help",     use: { ...devices["Pixel 7"] },
    testMatch: /help\/.*\.spec\.ts/ },
],
```

`test:e2e` keeps `--project=chromium`; `help:test` is `--project=help`.
One config, one device profile, clean separation, no grep flags.

### 8.4 Refuse to run against production

§2.3. At the top of the help suite:

```ts
// These scenarios toggle working days, which is a write. The config's
// default baseURL is the production deployment sharing the prod D1 —
// running there would corrupt real settings, not test them.
if (!process.env["E2E_BASE_URL"]) {
  throw new Error(
    "help:test requires E2E_BASE_URL pointing at a local stack " +
      "(see the webapp-e2e-full job in .github/workflows/deploy.yml). " +
      "It must never run against the production deployment.",
  );
}
```

**Allow-list, not deny-list.** Rejecting `pages.dev` sounds sufficient
and is not: the check misses a different case, an uppercase host, a
custom domain, and `*.workers.dev`. Accept only `localhost`, `127.0.0.1`
and `::1`, and trim the value first. The error message already promises
"a local stack" — the guard should be the shape that delivers it. When
the failure mode is writing to real users' settings, the default must be
refusal.

### 8.5 The suite asserts branch coverage

`webapp/e2e/help/scenarios.spec.ts`:

```ts
for (const scenario of executableHelpScenarios) {
  test(`help: ${scenario.id}`, async ({ page, request, baseURL }) => {
    await prepareHelpScenario(page, request, baseURL!, scenario);
    const trace = await runHelpScenario(page, scenario);

    // A scenario that ran zero steps, or took a different path than it
    // documents, is not a pass. deploy.yml:150 records what happens when
    // a suite is allowed to report green while doing nothing.
    expect(trace.stepsRun).toBeGreaterThan(0);
    expect(trace.branchesTaken).toEqual(scenario.expectedCiBranches ?? []);
  });
}
```

Non-executable scenarios get a structural test instead: every variant
present, every external step described, no executable steps claimed.

### 8.6 Errors name the scenario, step, and target

A bare Playwright locator timeout does not say which documented workflow
broke. Wrap each step so failures read:

```text
Scenario: configure-notifications
Step: 2 (click)
Target: push-toggle (kind=element)
Branch: push-available
```

### 8.7 Fixtures

`webapp/e2e/help/help-fixtures.ts` reuses the repository's existing test
auth — `requireTestAuth` from `e2e/helpers/test-auth.ts`, then
`/login` → `test-signin` → wait for `tab-bar`, matching the pattern in
`settings.spec.ts`. Do not invent a second auth mechanism, and do not copy
setup blocks into each scenario.

Where a scenario mutates shared state, reset it through the API the way
`resetGigListView` does, not through the UI.

**This is not optional for any scenario that toggles something.**
`configure-working-hours` switches Sunday on, and the setting is
persisted server-side for the shared dev user — so the second
consecutive run switches it back off, the row collapses, and the
`select` step times out waiting for a `start-day-0` that no longer
exists. Runs alternate pass/fail deterministically. It passes in CI only
because a fresh local D1 starts at the schema default; a change to that
default would break CI with a failure that reads like a scenario bug.

Resetting by reading current state and clicking conditionally is not the
fix — that would make the tour act on the user's behalf depending on
what it found, which is the one thing §7.3 forbids. Reset out of band,
before the scenario starts.

### 8.8 Type-check the seam

§2.2. Add `webapp/tsconfig.e2e.json` including `e2e`, and reference it
from `webapp/tsconfig.json`:

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

Without this, the runner's use of the shared model is unchecked and the
"one typed model" claim is false. Expect to fix pre-existing type errors
in `e2e/` that nothing has ever surfaced; fix them rather than loosening
the config.

### 8.9 Scripts

```json
"help:test": "playwright test --project=help",
"help:validate": "vitest run src/help"
```

`help:generate` arrives with PR 5. The production build must never depend
on any of these.

### 8.10 CI

Add help validation to the **`webapp-e2e-full`** job, after the existing
suite. It is the only job with a live test-auth bypass; in
`webapp-e2e-preview` the scenarios would skip and report green — the exact
failure mode `deploy.yml:150` documents.

Do not auto-commit generated artifacts from CI.

### PR 3 acceptance

- `pnpm typecheck` covers `e2e/`.
- Every executable scenario passes under `help:test` against a local stack.
- `help:test` refuses to run against production.
- Deleting a `data-testid` used by a scenario produces a failure naming
  the scenario, step, and target.
- Changing a scenario's real CI branch without updating
  `expectedCiBranches` fails.
- `pnpm test:e2e` runs exactly the specs it ran before.

---

## 9. PR 4 — Remaining scenarios

Working hours, email capture, and install variants, plus
`environment.ts` and the manual variant picker. Nothing new
architecturally; this is where the model earns its keep or reveals a gap.

If a scenario needs a step type that does not exist, add it — narrowly,
with a validator rule and a test. If a scenario needs a *general*
mechanism, stop and reconsider the scenario first (§3.5).

---

## 10. Failure behaviour

The asymmetry is deliberate.

**The message has to render where the failure happened.** A tour can
navigate before it fails — `open-settings` starts on `/` — so a notice
that only exists inside the help menu is a notice the user never sees,
because the menu lives on `/settings`. Mount it above the router, and
give it a way back to the menu rather than assuming the user is already
looking at one.

| | Missing target | Unmatched branch |
|---|---|---|
| **Interactive** | "This help step is currently unavailable", offer Close / Back to Help | end gracefully |
| **Playwright** | fail with scenario id + step index + target | throw |
| **Generation (PR 5)** | fail generation | fail — never silently omit |

A user hitting stale help should get a dead end they can back out of. A
developer hitting stale help should get a red build.

---

## 11. Security and privacy

Scenarios must never embed real credentials, production secrets, tokens,
private email addresses, or identifying test data. `InputStep.value` is
sample data, and the validator should be extended if a real-looking value
ever appears.

`capture-address-value` is a per-user forwarding address: highlight it,
never assert or record its contents beyond the shape check
`settings.spec.ts` already performs.

When PR 5 adds screenshots, they are generated from hermetic fixtures and
reviewed before being committed. Mask through fixtures, not image editing.

---

## 12. Performance

Help must not affect initial load. Lazy-`import()` Driver.js and the tour
runtime; load them when Help is opened. Scenario definitions stay
lightweight data. Playwright adapters and any future generator are
test/build tooling and never enter the production bundle.

Preserve offline and PWA behaviour — nothing here may change the service
worker or precache manifest.

---

## 13. PR sequence

**PR 1 — Model.** `targets.ts`, `types.ts`, `validate.ts`, `registry.ts`,
`open-settings`, unit tests, `jsdom` devDependency. No UI change.

**PR 2 — Interactive help.** Driver.js restyled, `HelpProvider`,
`HelpSection` on Settings, `HelpMenu`, `TourRenderer`, plus the
notifications scenario. User-visible.

**PR 3 — Validation.** `tsconfig.e2e.json`, help Playwright project,
runner with traces, fixtures, branch-coverage suite, production guard, CI
in `webapp-e2e-full`.

**PR 4 — Remaining scenarios.** Working hours, email capture, install
variants, environment detection, manual picker.

**PR 5 — Generated documentation (deferred).** Screenshots and Markdown.
See §14.

**Later — recorder, then AI-assisted authoring.** Only once PRs 1–4 are
stable. Neither is in scope now.

Make the smallest coherent change per PR. Do not rename unrelated test
IDs, do not refactor components beyond adding `settings-help`, and do not
replace existing E2E coverage.

---

## 14. Deferred: generated documentation (PR 5)

Recorded so the model does not foreclose it, explicitly out of scope now.

The work is larger than it looks. §2.3: there is no scripted local stack —
`webapp-e2e-full` assembles one across ~40 lines of CI YAML. A
`help:generate` that runs anywhere else either fails or photographs
production data, and §11 forbids the second. So PR 5 begins with a
scripted hermetic stack, not with screenshots.

When it happens:

- add `capture?: boolean` to explanatory steps;
- mark the target with a temporary attribute (`data-help-capture-active`)
  and an injected outline, removed immediately after capture — never
  alter production styling;
- fixed viewport, wait for fonts and application state, minimise
  animation, avoid non-deterministic content in frame;
- output to `docs/help/generated/assets/<scenario>/NN-step.png`;
- generate Markdown into `docs/help/generated/`, every file headed
  `<!-- GENERATED FILE. DO NOT EDIT MANUALLY. -->`;
- hand-written introductions live outside `generated/`;
- structural tests: every page maps to a registered scenario, every
  referenced screenshot exists, output paths are unique.

Run the generator as a Playwright spec rather than a standalone script.
`webapp/scripts/` is plain `.mjs` and the project has no `tsx` or
`ts-node`; Playwright already has a TypeScript loader and a browser, so
this avoids adding a second toolchain to import `registry.ts`.

Screenshots are documentation artifacts, not visual regression baselines.
No pixel-perfect assertions.

Note that all screenshots will be phone-shaped (§2.4). That suits Gigsy,
whose primary surface is a handset — but desktop install instructions will
be illustrated by a phone unless a desktop project is added first.

---

## 15. Localization

Do not couple to a localization framework, and do not make one
impossible. Initial model uses plain strings (`title: "Open Settings"`);
it can later become `titleKey: "help.openSettings.title"`. If Gigsy adopts
a canonical i18n mechanism before then, integrate with it rather than
creating a second translation system. Scenario *structure* stays
language-neutral regardless.

---

## 16. Non-goals

Not in this work: a documentation CMS, Docusaurus/VitePress, a generic
workflow scripting engine, automatic AI regeneration, automatic PR
creation for docs, computer-vision selector discovery, browser-extension
automation of browser chrome, pixel-perfect screenshot regression,
help-usage analytics, voice help, chatbot/RAG search, or generalized macro
automation.

The architecture permits some of these later. None may delay the core.

---

## 17. Definition of done

- [ ] `HelpScenario` domain types exist, with targets carrying a kind.
- [ ] `resolveTarget` reaches the painted switch, proven in jsdom;
      `targetSelector`'s switch form is proven end-to-end by PR 3.
- [ ] A registry exists and is the only discovery mechanism.
- [ ] Five scenarios: navigation, conditional, interactive, state-dependent,
      and external.
- [ ] A Help section is visible and keyboard-operable on Settings.
- [ ] Tours spotlight real controls, including painted switches.
- [ ] Users perform the instructed operations; the tour never clicks for
      them.
- [ ] Browser/OS actions are external steps, never executable ones.
- [ ] A Playwright adapter executes every executable scenario.
- [ ] `pnpm typecheck` covers `e2e/`.
- [ ] Help specs run under their own project, separate from `test:e2e`.
- [ ] `help:test` refuses to run against production.
- [ ] Branch coverage is asserted against `expectedCiBranches`.
- [ ] CI runs help validation in `webapp-e2e-full`.
- [ ] Existing E2E tests still pass, unmodified.
- [ ] Application behaviour is unchanged when help is inactive.
- [ ] Driver.js is absent from the initial bundle.
- [ ] `docs/plan.md` §13 gains Phase 13.
- [ ] Developer documentation explains how to add a scenario (§18).

---

## 18. Adding a scenario, afterwards

1. Ensure the elements have stable targets. If a control is a `Toggle`,
   register it as `painted(...)`, not `element(...)` — check the component,
   do not guess from the name.
2. Add the scenario under `webapp/src/help/scenarios/`.
3. Register it.
4. `pnpm help:validate`
5. `pnpm help:test` against a local stack. If it branches, set
   `expectedCiBranches` to what actually ran.
6. Review the interactive flow by eye — validation proves a selector
   resolves, not that the guidance makes sense.
7. Commit scenario and any target additions together.

---

## 19. Instructions to the implementing agent

Before changing code, read: `webapp/package.json`,
`webapp/playwright.config.ts`, `webapp/src/components/Toggle.tsx`,
`webapp/e2e/settings.spec.ts` (especially `paintedSwitch`),
`webapp/e2e/helpers/test-auth.ts`, `webapp/src/screens/Settings.tsx`,
`docs/design-system.md`, and the `webapp-e2e-full` job in
`.github/workflows/deploy.yml`.

Search for a `data-testid` before creating one. Follow existing naming,
formatting, import (explicit `.ts`/`.tsx` extensions), and comment
conventions — this codebase explains *why* in comments, and help code
should too.

After each PR:

```bash
pnpm typecheck && pnpm test && pnpm test:e2e
```

plus `pnpm help:validate` and `pnpm help:test` once they exist.

If an existing test fails because of this work, fix the regression. Do not
weaken or delete the test unless the previous behaviour was intentionally
changed and the change is documented.

---

## 20. Final rule

When a future feature needs user guidance:

```text
Product UI
    |
stable semantic/test target (with its kind recorded)
    |
HelpScenario
    |
    +--> interactive guidance
    +--> Playwright validation
    +--> generated documentation
```

Do not reproduce the same workflow independently in three systems.
