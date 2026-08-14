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
entered, not all of them up front, specifically because of this. If you
add a step type or a runtime, keep that property.

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

This runs `validateHelpRegistry` over every registered scenario —
structural checks only (duplicate ids, an empty branch, a branch nested
inside a branch, `expectedCiBranches` naming a branch that doesn't exist,
a non-executable scenario with no `fallback` variant, and so on). It
proves the scenario is well-formed. It does not run a browser and cannot
tell you whether a selector still resolves to anything — that's step 5.

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

## 6. Look at it

Validation and the Playwright suite prove a selector resolves. Neither
proves the guidance reads sensibly to a person. Run the app and follow
your own scenario:

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
