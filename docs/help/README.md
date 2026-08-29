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

**If a screen has more than one legitimate state, branch — don't
assume.** Push notifications are either offered or explained-as-blocked;
email capture is either configured or not. Settings.tsx renders exactly
one of the two, never both. A scenario that assumes one state and
instructs a click on a control the other state doesn't render is worse
than no help at all. Use a `branch` step with a `HelpCondition` per
state, and give every condition a real chance to hold — a branch step
with no matching condition is a hard failure, not a silent no-op.

**Say what the screen is SAYING, not what it has not got round to
saying — prefer `target-visible` over `target-missing`.** An element's
presence is a claim; its absence is three claims wearing one face. The
gig list is the worked example. `gig-filters` is mounted on
`all.length > 0`, and `all` is `gigs.data ?? []`, so it is missing when
the account owns no gigs, missing while the query is pending, and
missing after the query has errored. `find-a-gig` and `record-work`
both read that absence as "no gigs on this account", and both therefore
told people with hundreds of gigs that they had none for as long as a
cold sync took — the 250ms settle both adapters apply is a flicker
guard, not a network budget. The fix was not a longer debounce but a
positive target: Gigs.tsx's "No gigs yet" box carries `gigs-empty`, and
`gigs.data?.length === 0` is true in exactly one of the three states.

The trade is that loading and errored now match no alternative, and a
branch with no winner is a hard failure. Take it. Loading resolves well
inside the branch budget, and "help isn't available right now" is the
truth about a screen that failed to load — which is more than the
confident wrong answer it replaces. If you find yourself reaching for
`target-missing` to mean "this account has nothing", check first
whether the screen already says so somewhere you can tag.

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
targets are prose. `create-invoice` is the sharpest version of this: it
needs a client selected, and the runner cannot select one — a `select`
step names an option by value, and client ids are per-account UUIDs, not
a missing environment variable a future deploy might set. So
`expectedCiBranches` pins `invoice-needs-client` for good, and the
navigate step onto `/reports/invoice`, plus `invoice-document` and
`invoice-print` on the far side of it, are permanently prose — not
merely prose until someone configures the environment differently, the
way `push-toggle` and `capture-address-value` are. If you touch a
testid, grep `src/help/` for it yourself.

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

**Which row a person would actually tap.** A `navigate` step's
destination is asserted — the runner clicks the first row and waits for
the route — but the runner's choice is a stand-in, not the user's. A
scenario whose copy says "tap the gig you worked" is never checked
against whether the row a human would pick behaves the same way. That is
what the two branches at the end of `record-work` exist for, and running
it by hand on a gig the fixture did not create is the only thing that
proves them.

So run it yourself:

```bash
pnpm --filter gigsy-webapp dev
```

Press the "?" in the header, start the scenario, and do what it says — including
the click steps. The tour never performs the click for you (a working
day changes what a client sees on a public availability page, so the
tour asking a human to press the actual control isn't a UX nicety, it's
the whole point); if the popover text, the spotlight target, or the step
order doesn't make sense as a walkthrough, no test in this project will
catch that but you.

`e2e/help/reachability.spec.ts` covers one thing the scenario suite
structurally cannot — that help is reachable at all, through the
header's "?" button, and that a topic really starts a Driver.js tour.
It is deliberately a single test against `open-settings`; do not add a
per-scenario copy of it.

Help used to have a second door, a "Help" group on the Settings screen.
It was removed: the header button already opened the same menu from
every screen, `/settings` included, so the Settings group was a second
way into one menu and the narrower of the two.

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
