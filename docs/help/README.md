# Adding a help scenario

Scenarios live in `webapp/src/help/scenarios/` and are plain data — one
`HelpScenario` per topic, registered in `webapp/src/help/registry.ts`. The
model itself is documented in
`docs/gigsy-executable-help-implementation-spec.md`; this file is the
day-to-day checklist, plus the things that only became clear once the five
MVP scenarios were actually built and run.

## 1. Give the elements stable targets

Add them to `HelpTarget` in `webapp/src/help/targets.ts`.

**Check the component before choosing a kind — never guess from the
name.** A target is `element(...)` or `painted(...)`, and the two resolve
completely differently:

- `Toggle` (`webapp/src/components/Toggle.tsx`) puts its `data-testid` on
  a 1×1 `sr-only` checkbox. The thing a person actually sees and taps is a
  sibling `<span aria-hidden="true">` inside the wrapping `<label>`.
  Register these as `painted(...)`. Clicking the tagged input directly —
  in a test, or by pointing a tour spotlight at it — either highlights an
  invisible box or passes a test while proving nothing a user could do.
- Everything else (`Button`, `Select`, `Link`) is `element(...)`.

The name of the test ID is not evidence either way. `push-toggle` is a
`<Button>` (`Settings.tsx`), not a `Toggle`, despite the name — it's an
`element`. `toggle-prefix` is a calendar title-prefix switch and *is* a
real `Toggle` — it's `painted`. Go read the component.

## 2. Write the scenario

**Give it a `startRoute` it can actually start from.** The provider
navigates there before the tour begins, and this is not optional
bookkeeping — some targets are conditionally rendered. `settings-link` is
hidden by `AppHeader` while you're already on `/settings`, so a scenario
that wants to demonstrate reaching Settings has to start from `/`.

**A step's target may not exist yet, even at the right route.**
`AvailabilitySection` renders `start-day-N` only once day N's switch is
on. Do not assume every target in a scenario exists when the scenario
starts — the tour renderer resolves each step's target when that step is
entered, not all of them up front, specifically because of this. (It
hands Driver.js `targetSelector`'s *string*, never a node, so
`waitForElement` re-queries it — `TourRenderer.ts`.) If you add a step
type or a runtime, keep that property.

**That is true of targets. It is NOT true of branches — and the two
adapters differ.** `TourRenderer.runTour` calls `flatten()` over the
whole scenario *before* `tour.drive()`, so every branch step is resolved
against the DOM as it looks when the tour starts, while the user has
done nothing yet. `help-runner.ts`'s `runSteps` walks the list in order
and resolves each branch step at the moment it reaches it, after every
earlier step has already run.

For a branch that sits before any interaction — both of today's, on
`/settings` — the two agree. Put a branch *after* a click, `input` or
`select` and they diverge: the runner sees the post-interaction DOM and
picks correctly, the tour evaluates the same condition against the
pre-interaction DOM and may pick the other branch or, if neither
condition holds yet, give up with "no branch matched" and show the
unavailable banner. **You can write a scenario that passes `help:test`
and is broken for every real user.** Nothing catches it.

So: keep branch steps ahead of the first user interaction. If a scenario
genuinely needs to branch on state the user has just created, fix
`flatten()` to resolve branches lazily first — do not ship the scenario
against the current renderer and trust the green suite.

**If a screen has more than one legitimate state, branch — don't
assume.** Push notifications are either offered or explained-as-blocked;
email capture is either configured or not. Settings.tsx renders exactly
one of the two, never both. A scenario that assumes one state and
instructs a click on a control the other state doesn't render is worse
than no help at all. Use a `branch` step with a `HelpCondition` per
state, and give every condition a real chance to hold — a branch step
with no matching condition is a hard failure, not a silent no-op.

**If your scenario toggles something persisted, reset it in the Playwright
fixture — never by reading state and clicking conditionally.**
`configure-working-hours` flips Sunday on. That setting is written
server-side for the shared dev user, so without a reset the second
consecutive run finds Sunday already on, flips it off, the row collapses,
and the following `select` step times out waiting for a `start-day-0`
that no longer renders — runs alternate pass/fail by construction, not by
flakiness. `help-fixtures.ts`'s `resetWorkingWeek` fixes the precondition
through a direct `PATCH /api/settings` call before the scenario's own
steps run, the same way `resetGigListView` resets state for the ordinary
E2E suite. Resetting by reading the current state and clicking whichever
control gets you to the reset state is not a substitute: that would make
the *tour* decide and act depending on what it found, which is precisely
what the "the user performs the click" rule forbids the tour from doing.
Keep the reset in the fixture, out of band, before any step runs.

## 3. Register it

Add it to `helpScenarios` in `webapp/src/help/registry.ts`.

## 4. Validate

```bash
pnpm --filter gigsy-webapp help:validate
```

Despite the name, this is `vitest run src/help` — the **whole** help unit
suite (101 tests at the time of writing), not just the validator. That
includes
`TourRenderer.driver.test.ts`, which drives the real Driver.js library in
jsdom and takes ~16s on its own, so budget around twenty seconds rather
than the instant answer the name suggests. It is a superset of what
`pnpm --filter gigsy-webapp test` runs for `src/help`, so running both
is redundant; this is the narrower one.

The part that checks your scenario is `validateHelpRegistry`, which is
structural only (duplicate ids, an empty branch, a branch nested inside a
branch, `expectedCiBranches` naming a branch that doesn't exist, a
non-executable scenario with no `fallback` variant or with no variants at
all, and so on). It proves the scenario is well-formed. It does not run a
browser and cannot tell you whether a selector still resolves to
anything — that's step 5.

## 5. Run it against a local stack

`help:test` refuses to run anywhere but localhost, on purpose: these
scenarios write settings (toggling a working day is one of them), and
Playwright's default target here is the production deployment sharing
production D1. Bring up the same hermetic local stack the
`webapp-e2e-full` job builds in `.github/workflows/deploy.yml`:

```bash
# backend — local worker on a throwaway local D1
cd backend
cp .dev.vars.example .dev.vars
pnpm exec wrangler d1 migrations apply gigsy-db --local
pnpm exec wrangler dev --port 8787

# webapp — in a second shell
cd webapp
pnpm dev --port 5192 --host 127.0.0.1
```

Then, from `webapp/`:

```bash
E2E_BASE_URL=http://127.0.0.1:5192 E2E_REQUIRE_AUTH=1 pnpm help:test
```

Run it more than once in a row. A scenario that only passes on the first
run of a session and fails on the second (or vice versa) almost always
means step 2's reset is missing or incomplete, not that the suite is
flaky.

**`expectedCiBranches` is determined empirically — run the suite, don't
guess.** `configure-notifications` declares `["push-blocked"]` because
headless Chromium can't grant notification permission and the local
worker has no VAPID config, so the blocked branch is the only one CI can
ever take; `set-up-email-capture` declares `["capture-unconfigured"]`
because the local backend has no `CAPTURE_EMAIL_DOMAIN` set. Both were
confirmed by actually running `help:test` against the local stack
repeatedly, not by reading the config and assuming. If the assertion
fails when you run your own scenario, that is a signal to diagnose, not
a prompt to edit the declaration to match whatever happened:

- If it fails **intermittently**, that's a race — usually a branch
  condition settling after the first check. The fix is stability margin
  in the runner or renderer (see `BRANCH_APPEAR_TIMEOUT_MS` and the
  settle-then-recheck pattern in `help-runner.ts`), not a looser
  assertion.
- If it fails **consistently** and the new branch is the correct one for
  this environment, update `expectedCiBranches` — but say why in a
  comment, the way the existing scenarios do. Editing the declaration to
  match a flake instead of fixing the race enshrines the wrong branch and
  quietly retires the coverage for the branch CI used to exercise.

## 6. Look at it — and know what the suite cannot see

Validation and the Playwright suite prove a selector resolves. That is
less than it sounds like, and the gaps are all in the same direction: a
green run does **not** mean the help is right. Four things it will never
tell you.

**Targets on branches CI doesn't take.** A scenario runs exactly one
branch per run, and `expectedCiBranches` pins which. Everything inside
the other branch — including its step targets — is never resolved.
Rename `push-toggle` (only reachable via `configure-notifications`'
`push-available` branch) or `capture-address-value` (only via
`set-up-email-capture`'s `capture-configured` branch) and `help:test`
stays green: the guarding `target-visible` condition simply stops
holding, the declared branch runs as usual, and nothing notices. Those
targets are prose. If you touch a testid, grep `src/help/` for it
yourself.

**What a step actually does.** `performAction` clicks and moves on; it
asserts nothing about the result. `open-settings` clicks `settings-link`
and passes — `scenarios.spec.ts` would pass with the link's `to` pointing
at a route that doesn't exist, because a click on a present element is
all it checks. A scenario proves its controls are *findable and
operable*, not that following it gets you anywhere. (`reachability.spec.ts`
happens to assert the arrival for this one click, as a side effect of
testing the tour runtime. Nothing does it for the other scenarios.)

**Whether the prose is true.** Nothing compares a step's `description`
to what the control does. Copy that was accurate when it was written and
has since been overtaken by a feature change reads as confidently as
ever, and the suite is green throughout. Same for step order and for
whether the walkthrough makes sense end to end.

**A branch placed after an interaction.** See §2 — the runner and the
in-app tour resolve branches at different times, and only the runner's
answer is tested.

So run it yourself:

```bash
pnpm --filter gigsy-webapp dev
```

Open Settings → Help, start the scenario, and do what it says — including
the click steps. The tour never performs the click for you (a working
day changes what a client sees on a public availability page, so the
tour asking a human to press the actual control isn't a UX nicety, it's
the whole point); if the popover text, the spotlight target, or the step
order doesn't make sense as a walkthrough, no test in this project will
catch that but you.

`e2e/help/reachability.spec.ts` covers one thing the scenario suite
structurally cannot — that help is reachable from Settings at all and
that a topic really starts a Driver.js tour. It is deliberately a single
test against `open-settings`; do not add a per-scenario copy of it.

## 7. Final check before committing

```bash
pnpm --filter gigsy-webapp typecheck
pnpm --filter gigsy-webapp test
pnpm --filter gigsy-webapp help:validate
E2E_BASE_URL=http://127.0.0.1:5192 E2E_REQUIRE_AUTH=1 pnpm --filter gigsy-webapp help:test
E2E_BASE_URL=http://127.0.0.1:5192 E2E_REQUIRE_AUTH=1 pnpm --filter gigsy-webapp test:e2e
```

Commit the scenario, any new `HelpTarget` entries, and the registry
change together.
