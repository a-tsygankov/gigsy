# Mid-tour navigation and lazy branches — design

Date: 2026-08-26
Branch: `claude/heuristic-leakey-8f9ab5`
Status: approved, ready for planning
Fixes: `record-work` is broken for every real user

## Why

`webapp/src/help/scenarios/record-work.ts` starts on a gig that only
exists in CI:

```ts
export const RECORD_WORK_GIG_ID = "11111111-1111-4111-a111-111111111111";
startRoute: `/gigs/${RECORD_WORK_GIG_ID}`
```

`webapp/e2e/help/help-fixtures.ts`'s `ensureRecordWorkGig` upserts that
id for the shared dev account before every Playwright run, so
`help:test` passes. On a real account the gig does not exist,
`GigDetail.tsx` takes its `gig.isError` path and renders "Couldn't open
this gig — it may have been deleted", and the whole `{data !== undefined
&& (...)}` block never renders. All seven of the scenario's targets —
`gig-status`, `work-start`, `work-stop`, `gig-break`,
`gig-expected-pay`, `gig-override`, `gig-payments` — go unresolved, and
every step degrades to prose with no spotlight.

This is precisely the failure mode `docs/help/README.md` §6 warns about,
arriving by a road that section does not list: not a branch CI never
takes, but a *precondition* CI manufactures.

### Audit: no other scenario has this flaw

Every other `startRoute` is a static, always-reachable route — `/`,
`/gigs`, `/gigs/new`, `/clients/new`, `/expenses/new`, `/capture`,
`/settings`. Each of their targets was checked for conditional
rendering: `expense-gig` (`ExpenseEdit.tsx`), `capture-start`
(`Capture.tsx`) and the whole gig and client forms are unconditional,
and the three `/settings` scenarios plus `connect-calendar` and
`find-a-gig` already branch over their legitimate states.

`ensureAtLeastOneGig` exists in the same fixture file and looks similar,
but is not the same thing: `find-a-gig` branches correctly on an empty
account, so that fixture pins a CI *branch* precondition rather than
hiding a break.

### Why the obvious fixes do not work

`find-a-gig`'s header already explains why no scenario can point at "a
row in the list": `CardLink`s carry no identifier a `HelpTarget` can
read, a `HelpTarget` resolves one static CSS selector with no runtime
parameter (`targets.ts`), and `types.ts` deliberately has no
`NavigateStep`, so a scenario gets exactly one `startRoute` and no
mid-tour navigation.

Two further constraints were confirmed against the code rather than
assumed:

- `HelpProvider.tsx`'s route-change effect **actively cancels** a
  running tour on any route change it did not itself cause. "Start on
  the list, tap a gig, keep going" is therefore a renderer change, not
  a scenario-file change.
- Landing on a real gig still does not resolve all seven targets.
  `gig-override` is gated on `isHourly` (`WorkCard.tsx`), which is
  exactly why the fixture pins `payType: "hourly"`; `gig-expected-pay`
  is gated on `payLine !== null`, and `expectedCents` (`lib/gig-pay.ts`)
  returns null for a fixed gig with no offered amount and for an hourly
  gig with no rate or no billable minutes.

## Decisions taken

| Question | Decision |
|---|---|
| Which gig does the tour land on? | The one the **user taps**. The tour follows them across the screen change. |
| Does the tour ever navigate itself? | **No.** A navigate step declares that the user's tap will move them; the tour only survives it. |
| The two conditional controls | Kept, behind branches — which forces `flatten()` to become lazy. |
| Overlap with `find-a-gig` | One step, then hand over. `record-work` does not re-explain search and filters. |
| A branch alternative that cannot continue | A **terminal step**. Branches stay un-nested. |
| Progress counter growing mid-tour | **Accepted** and commented, not faked. |
| `ensureAtLeastOneGig` | **Deleted** — the record-work upsert is unconditional and subsumes it. |

## The model change

Two additions to `webapp/src/help/types.ts`: a new step type, and a flag
any step may carry.

### The navigate step

This replaces that file's standing `// No NavigateStep` note —
"add it when something actually needs it". Something now does.

```ts
export interface NavigateStep {
  action: "navigate";
  /** What they tap. A CONTAINER of choices, not one control: the tour
   *  spotlights the whole list and the person picks their own row. */
  target: HelpTarget;
  /** Route pattern the tap must land on — ":param" matches one path
   *  segment. Both adapters read it: the provider adds it to the
   *  routes it will tolerate mid-tour, the runner waits for the URL to
   *  match it. */
  route: string;
  title?: string;
  description: string;
}
```

`title` and `description` are shown inline above for readability; in
the file they come from the shared `HelpStepBase` introduced below,
which every non-branch step interface extends.

The name says where the *user* goes, not what the tour does. The rule
that shapes `TourRenderer.ts` — the user performs the action — is
untouched, and here it is forced anyway: only their own tap knows which
gig they meant.

### Terminal steps

A branch step's alternatives are not required to be equally
continuable, and until now that never mattered: `find-a-gig` **is** one
branch step with nothing after it. `record-work` breaks that shape —
its opening branch has three alternatives and only one of them can go
on to a gig. Steps written after a branch step run whatever branch was
taken, so Payments and the two pay branches would also run for
`no-gigs-yet`, on `/gigs`, where none of their targets exist.

Moving the tail inside the `gigs-showing` branch is not available:
`validate.ts` rejects a branch nested inside a branch, and `flatten()`
bails on one. That rule stays — see "What this design does not do".

So a step may declare that the tour ends on it:

```ts
interface HelpStepBase {
  title?: string;
  description: string;
  /** The tour ends here. Everything after this step — including steps
   *  written after the branch this one sits in — is not reached.
   *
   *  For a path that legitimately cannot continue: `no-gigs-yet` has no
   *  row to tap, so the steps that walk a gig's Work card must not run
   *  after it. `find-a-gig` says exactly this in prose today ("This
   *  walkthrough stops here"); this makes it something both adapters
   *  can act on. */
  end?: true;
}
```

All six non-branch step interfaces extend it — the five that exist plus
`NavigateStep` above; `BranchStep` does not
(it carries no copy of its own, and a branch that ends the tour is a
branch with a terminal step at the end of each alternative).

Both adapters honour it the same way. `flatten` stops appending once it
appends a terminal step, so Driver.js's array simply ends there and its
last popover renders "Done" with no special casing. `runSteps` unwinds
out of its own recursion and returns, so `trace.stepsRun` counts what
actually ran.

The cost, stated plainly: control flow after a branch step becomes
implicit — a reader has to notice that the tail belongs to the one
alternative that did not end. `record-work` gets a comment saying so,
the way every non-obvious choice in that directory does.

### Route patterns

A new `webapp/src/help/routes.ts` holds pattern matching (`/gigs/:id` →
a predicate over a pathname) as plain data with no DOM, no React and no
Playwright, so the provider, the renderer and the Playwright runner
share one definition rather than three regexes that drift.

`routes.ts` exports two functions:

- `matchesRoute(pattern: string, pathname: string): boolean` — a
  `:param` segment matches exactly one path segment, nothing else is
  special, and a literal pattern is a string comparison.
- `allowedRoutes(scenario: HelpScenario): string[]` — the scenario's
  `startRoute` plus every navigate step's `route`, branches included.
  This is what the provider polices against.

## The runtime change

### `flatten()` becomes lazy

This is the substantial piece. Today `runTour` flattens every branch
against the DOM as it looks before `tour.drive()`, while the user has
done nothing. `docs/help/README.md` §2 documents the consequence in
plain terms — *"You can write a scenario that passes `help:test` and is
broken for every real user"* — and tells whoever hits it to fix
`flatten()` first rather than ship against the current renderer. This
change is that fix, and mid-tour navigation is what finally makes a
post-interaction branch unavoidable.

Verified against driver.js 1.8.0's own source, not assumed:

- `setSteps(steps)` and `drive(stepIndex)` both exist.
- A step-level `popover.onNextClick` **fully replaces** Driver's
  internal advance. `B()` composes `onNextClick: m || n.onNextClick`
  where `m` is the step's own hook and `n.onNextClick` is Driver's
  default, so a step-level hook must call `moveNext()` itself. That
  makes the boundary interceptable without sentinel steps.
- On the last known step Driver prefers `onDoneClick`, falling through
  to `onNextClick` when it is unset (`L()`). We never set
  `onDoneClick`, so one hook covers both the Next and Done buttons.
- `waitForElement` installs a `MutationObserver` on
  `document.documentElement` and defers `onHighlightStarted` until the
  element appears or the budget expires (`m()`'s `p()` path). A
  full React screen swap is therefore survivable: the observer outlives
  the remount because it is attached above `#root`.

The shape:

- `runTour` resolves the leading non-branch steps, hands those to
  Driver, and keeps the unresolved remainder as model steps.
- Resolution happens **ahead** of the boundary, not at Next-press. A
  branch's conditions become readable the moment its screen mounts, so
  `record-work`'s two pay branches settle while the user is still
  reading the Status step. `settleBranch`'s existing debounce is reused
  unchanged — the flicker it guards against is the same one.
- The step-level `onNextClick` on the last currently-known step is the
  safety net for a user who outruns resolution: it awaits the pending
  branch, `setSteps` the expanded array, and `drive(index + 1)`.
- A branch that never settles reaches `onUnavailable("no branch
  matched")` exactly as it does today. Lazy resolution changes *when*
  that verdict is reached, not what it is.

Known cosmetic consequence, accepted deliberately: `showProgress`
renders `{{total}}` from the current array length, so "2 of 5" can
become "2 of 8" when a branch expands. Because resolution runs ahead,
the total updates early and once. Faking a total — the longest branch
path, say — would be a number that is wrong for every run instead of a
number that is briefly incomplete. This gets a comment, not a
workaround.

### `watchTarget` is suppressed for a navigate step

`TourRenderer.ts`'s `watchTarget` exists to catch a target that leaves
the page mid-step, because Driver.js resolves `element` once and never
looks again. For a navigate step that is inverted: the target vanishing
**is** the success case. Left as-is, the tour reports `target gig-list
disappeared` the instant the list unmounts and dies on the hop it was
built to make.

### `isUserInteraction` gains `"navigate"`

A navigate step puts an entirely new screen on the page, so everything
after it is a re-render away rather than a network round trip away —
the exact distinction `TARGET_WAIT_BEFORE_INTERACTION_MS` versus
`TARGET_WAIT_AFTER_INTERACTION_MS` draws.

Advancing works exactly as a `click` step does: the listener sits on the
`gig-list` div and a tap on any `CardLink` inside bubbles up to it. The
popover shows `["close"]` only — there is no Next, because the step
completes by being done.

### `HelpProvider` tolerates declared routes

`expectedRouteRef` is a single pathname string today, and the
route-change effect cancels the tour whenever the router disagrees with
it. It becomes the scenario's allowed route *patterns*
(`allowedRoutes`), matched with `matchesRoute`. Leaving for `/settings`
still kills the tour; the declared hop from `/gigs` to `/gigs/:id` no
longer does.

The startRoute wait in `startScenario` is unchanged: `startRoute` stays
a literal string, so `waitForRoute`'s predicate keeps comparing exactly.

## The Playwright adapter change

`performAction` in `webapp/e2e/help/help-runner.ts` gains a `navigate`
case. This also satisfies the exhaustiveness guard already sitting in
that switch, which was written anticipating this step and fails the
build rather than silently skipping an unknown action.

```ts
case "navigate": {
  const container = locatorFor(page, step.target);
  await expect(container).toBeVisible({ timeout: TARGET_APPEAR_TIMEOUT_MS });
  // The tour spotlights a container of choices and lets the person
  // pick their own. The runner has no preference, so it takes the
  // first — a stand-in for the tap, not a claim about which row
  // matters.
  await container.locator("a[href]").first().click();
  await page.waitForURL((url) => matchesRoute(step.route, url.pathname), {
    timeout: TARGET_APPEAR_TIMEOUT_MS,
  });
  return;
}
```

Nothing about branch handling changes here: `runSteps` already resolves
each branch at the moment it reaches it. What changes is that the
in-app tour finally agrees with it. README §2's divergence warning
becomes a description of history rather than a live trap.

## The fixture change

`RECORD_WORK_GIG_ID` leaves `record-work.ts` entirely. No scenario knows
a gig id any more, which is the property that was missing.

`ensureRecordWorkGig` stays in `help-fixtures.ts`, keeps its fixed UUID
and its load-bearing `payType: "hourly"` plus rate, and gains a
far-future `dateTime`. The default saved view sorts `newest` —
`dateTime` descending, nulls last (`lib/gig-filters.ts`) — so that gig
is row 1 on every run and "the runner clicks the first row" is
deterministic across a freshly migrated D1 and the shared dev account
alike. It becomes a precondition pin in the same family as
`resetGigListView` and `resetWorkingWeek`, rather than a scenario's
private data.

`ensureAtLeastOneGig` is deleted. Its whole job was guaranteeing the
account owns a gig so `find-a-gig` takes `gigs-showing`; the record-work
upsert is unconditional and guarantees the same thing for every
scenario. Two functions asserting one precondition is one more than
needs to stay true.

## What `record-work` becomes

`startRoute: "/gigs"`, opening with a branch over the same three list
states `find-a-gig` already documents and justifies against `Gigs.tsx`:

- **`gigs-showing`** — a `navigate` step on `gig-list`: tap the gig you
  want to record work on, with a pointer to "Find a gig and open it"
  for narrowing a long list. Then Status, Start, Stop and Off-time
  breaks on the gig's own screen. No terminal step — this is the path
  that continues.
- **`gigs-hidden-by-filters`** and **`no-gigs-yet`** — the advice, no
  navigate step, and a **terminal step** at the end of each. Help must
  never ask for a tap that cannot happen, and the steps below must not
  run on a screen these two never leave.

Then, at the scenario's top level and therefore reached only by the
alternative that did not end, two branch steps for the conditional
controls, both resolving against the gig the user chose:

- on `gig-expected-pay` — the "what it's worth" step, or, when no figure
  can be computed, a step pointing at the Edit button, because a rate or
  an offered amount is what is missing.
- on `gig-override` — the Override step, or, on a fixed-fee gig, a step
  saying so and pointing at the same Edit button, where Paid by lives.

Every one of those four alternatives needs a real target: a branch's
step list may not be empty (`validate.ts`), and `gig-edit` is
unconditional on the detail screen, so both fallbacks have one.

Payments is the last top-level step, after both pay branches — the
order the current scenario already walks the card in.

The scenario's own header keeps its existing "left out, on purpose"
section and its explanation of why every step is a `highlight` — this
card writes on change, on blur and on Enter, with no Save button, so a
`click` or `input` step would stamp a real record. The navigate step
does not break that rule: tapping a row is a read.

`expectedCiBranches` becomes three ids and is **determined empirically**
per README §5 — run the suite, do not guess, and if the assertion fails,
diagnose before editing the declaration.

## Validator additions

In `webapp/src/help/validate.ts`, structural only, as everything there
is:

- a navigate step whose `route` is empty or does not start with `/`;
- a navigate step in a scenario marked `executable: false` — a
  non-executable scenario is browser and OS chrome, where there is no
  route to reach;
- `everyStepExternal` must keep treating a navigate step as executable,
  so "executable but every step is external" stays correct;
- `end: true` on anything but the last step of its own list — a
  terminal step with steps written after it inside the same branch
  silently drops them, which is the class of quiet wrongness this
  validator exists to make loud.

Deliberately **not** a rule: a terminal step at the end of a scenario's
top-level list, where it is a harmless no-op. Rejecting it would mean
the validator arguing about redundancy rather than correctness.

An unknown target still cannot happen at all: steps hold `HelpTarget`
objects, so TypeScript rejects one that does not exist.

## Testing

| Layer | What it must prove |
|---|---|
| `routes.test.ts` (new) | `:param` matches one segment and not two; a literal pattern is exact; `allowedRoutes` reaches inside branches. |
| `validate.test.ts` | Each new rule fires, and does not fire on the valid shapes. |
| `TourRenderer.test.ts` | A branch after a navigate step resolves against the post-navigation DOM; a navigate step's target disappearing does not end the tour; `isUserInteraction` shortens the wait after it; a terminal step inside a branch stops the flat list there, and the steps written after that branch are not appended. |
| `TourRenderer.driver.test.ts` | Real Driver.js: `setSteps` + `drive(index)` expansion lands on the right step, and the step-level `onNextClick` advances rather than destroying. |
| `HelpProvider.test.tsx` | A route change matching a declared navigate route does not cancel; one that does not still cancels. |
| `registry.test.ts` | `record-work`'s `startRoute` is `/gigs` and it holds no gig id. |
| `help-runner.ts` (via `scenarios.spec.ts`) | A terminal step unwinds out of the branch recursion, so `trace.stepsRun` counts what actually ran and no post-branch step is attempted. |
| `scenarios.spec.ts` | No code change — its `expectedCiBranches` assertion is already data-driven. |

Plus the two things no suite can see, per README §6: run the tour by
hand against a local stack, on an hourly gig and on a fixed-fee one, and
confirm the branches read correctly as prose in both.

## Documentation

- `docs/help/README.md` §2's post-interaction-branch warning is
  rewritten: lazy resolution is what the adapters now share, and the
  rule becomes "declare the hop with a navigate step" rather than "keep
  branches ahead of the first interaction".
- §6's list of what the suite cannot see keeps its four items; the
  fourth ("a branch placed after an interaction") is replaced with the
  new gap — a navigate step's *destination* is asserted by the runner,
  but which row a person would actually tap is not.
- A new §2 note on navigate steps: the target is a container, the runner
  takes the first link inside it, and the route pattern is what both
  adapters agree on.
- A new §2 note on terminal steps: a branch alternative that cannot
  continue must end on one, and steps written after a branch belong to
  whichever alternative did not.
- `docs/gigsy-executable-help-implementation-spec.md`'s model section
  gains `NavigateStep` and loses the "No NavigateStep" rationale.

## What this design does not do

- **No parameterised `HelpTarget`.** A target still resolves one static
  selector. Pointing at a specific row remains impossible, and remains
  unnecessary: the user picks.
- **No tour-driven navigation.** Nothing in the model lets a scenario
  move the user itself. If a future scenario wants that, it is a
  separate decision about the rule that the user performs the action.
- **No merge of `find-a-gig` and `record-work`.** They stay two topics;
  `record-work` hands over rather than re-explaining.
- **No nested branches.** `validate.ts`'s rule stands. A branch
  alternative that cannot continue ends on a terminal step instead,
  which keeps a scenario readable top to bottom and keeps
  `expectedCiBranches` a flat ordered list.
- **No `optional` step flag.** A control that is absent for a real
  reason gets a branch that says the reason. Silently skipping a missing
  target is the failure mode README §6 already warns about.
- **No change to which controls `record-work` walks.** The Started and
  Finished `DateTimeField`s, additional services, and the Edit button
  onto the job form stay out for the reasons that file's header gives.
