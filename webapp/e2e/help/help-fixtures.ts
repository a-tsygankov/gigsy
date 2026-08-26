/**
 * Shared setup for help-scenario specs.
 *
 * Two responsibilities: refusing to run against production at all
 * (requireLocalTarget), and getting a scenario to the point its first
 * step can run (prepareHelpScenario) — sign in the one way this suite
 * already does it, then navigate to wherever the scenario starts. Kept
 * here so a spec never grows a second auth mechanism or copies this
 * setup block per test, the way settings.spec.ts's beforeEach shows it
 * done once for the rest of the suite.
 */
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { requireTestAuth, resetGigListView } from "../helpers/test-auth.ts";
import type { HelpScenario } from "../../src/help/types.ts";

/** Hosts a local stack can legitimately be reached at. `"[::1]"` keeps
 *  its brackets because that's the literal form `URL#hostname` returns
 *  for an IPv6 literal — checked against Node's own URL parser, not
 *  assumed. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Refuses to run anywhere but a local stack.
 *
 * playwright.config.ts defaults `baseURL` to the production Pages
 * deployment, and the suite otherwise shares the production D1 there —
 * tolerable for read-mostly specs, but help scenarios WRITE settings
 * (toggling a working day is one of them). Running them against
 * production would corrupt real data, not test anything.
 *
 * Allow-list, not deny-list. An earlier version matched the literal
 * string "pages.dev" and rejected only that: a custom domain, a
 * "*.workers.dev" deployment, mismatched casing ("PAGES.DEV"), or
 * untrimmed whitespace all sailed straight through. The error message
 * below has always promised "a local stack" — this makes that literally
 * true by accepting only the hosts a local stack actually runs on,
 * rather than trying to enumerate every host it must not be.
 */
export function requireLocalTarget(): void {
  const raw = process.env["E2E_BASE_URL"];
  const target = raw?.trim();
  if (target === undefined || target === "") {
    throw new Error(
      "help:test requires E2E_BASE_URL pointing at a local stack (see the " +
        "webapp-e2e-full job in .github/workflows/deploy.yml). It must " +
        "never run against the production deployment.",
    );
  }

  let hostname: string;
  try {
    hostname = new URL(target).hostname.toLowerCase();
  } catch {
    throw new Error(
      "help:test requires E2E_BASE_URL to be a valid URL pointing at a " +
        `local stack, got ${JSON.stringify(target)}.`,
    );
  }

  if (!LOCAL_HOSTS.has(hostname)) {
    throw new Error(
      `help:test refuses to run against ${target}: these scenarios write ` +
        "settings, so E2E_BASE_URL must point at a local stack " +
        `(localhost, 127.0.0.1, or ::1) — got host "${hostname}".`,
    );
  }
}

/**
 * Put the shared dev user's working week back to the schema default —
 * Sunday and Saturday off, Monday through Friday 09:00–17:00
 * (backend/src/domain/settings.ts's own default for
 * `availabilityWorkingWeek`; the shape is
 * `({ startMinute: number; endMinute: number } | null)[]`, Sunday first,
 * per settings-schema.ts and working-week.ts).
 *
 * `configure-working-hours` toggles Sunday, which is persisted
 * server-side for the shared dev user — and a click always flips
 * whatever is there, whether the run before it passed or failed. Running
 * `help:test` back to back against the same local stack was observed to
 * alternate pass/fail/pass/fail/pass: a run that starts with Sunday off
 * turns it on and finds `start-day-0`; the next run starts with Sunday
 * on, the click turns it off, the row collapses, and the `select` step
 * times out waiting for a select that will never render. That is a
 * failure in a scenario that did nothing wrong — indistinguishable from
 * a real regression to whoever is iterating on it — so the precondition
 * has to be pinned before every run, the same way `resetGigListView`
 * pins the gig-list view before every gig-list test.
 *
 * Driven through the API rather than the UI, and for the same reason
 * `resetGigListView` is: a UI reset would mean loading `/settings`,
 * finding whichever day is currently on, and clicking it off before the
 * scenario's own navigation and clicks even start — another chance for
 * exactly the flakiness this function exists to remove, and pointless
 * work when a PATCH says the same thing in one call.
 */
export async function resetWorkingWeek(
  request: APIRequestContext,
  baseURL: string,
): Promise<void> {
  const login = await request.post(`${baseURL}/api/auth/test-login`, {
    data: { email: "dev@test.local" },
  });
  if (!login.ok()) return; // No test auth here; the spec skips anyway.
  const { accessToken } = (await login.json()) as { accessToken: string };

  const nineToFive = { startMinute: 540, endMinute: 1020 };
  await request.patch(`${baseURL}/api/settings`, {
    headers: { authorization: `Bearer ${accessToken}` },
    data: {
      availabilityWorkingWeek: [
        null,
        nineToFive,
        nineToFive,
        nineToFive,
        nineToFive,
        nineToFive,
        null,
      ],
    },
  });
}

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

/**
 * Wait until the gig list a scenario is about to read actually reflects
 * the server.
 *
 * The reason this is needed is not latency, it is architecture. Reads go
 * through `OfflineDataService`, whose `listGigs()` returns whatever is in
 * the local IndexedDB store and never touches the network
 * (data-service.ts; docs/plan.md §7 — "reads/writes never block on the
 * network"). A Playwright context starts with an empty IndexedDB, so
 * `/gigs` opens with `gigs.data === []`, `all.length === 0`, and
 * therefore the "No gigs yet" empty state with no `gig-filters` at all —
 * for however long SyncEngine's first `pull()` takes to write however
 * many rows the account has. Every one of those states is a legitimate
 * render of the screen; that is exactly why `find-a-gig` branches on
 * them.
 *
 * Which makes this a precondition problem, not a flake. `find-a-gig`'s
 * `no-gigs-yet` condition is *correct* during that window, so the
 * settle-then-recheck debounce in help-runner.ts does not save it — it
 * commits to that branch and every target on the branch that matters
 * (`gig-search`, `gig-filters-toggle`, `gig-list`) goes unresolved,
 * which the README's §6 warns turns them into prose.
 *
 * That is still true after the condition stopped being `target-missing
 * gig-filters` and became `target-visible gigs-empty`. The change fixed
 * a different, larger hole — the filter bar is also absent while the
 * query is PENDING and after it has ERRORED, neither of which is a
 * statement about the account (help/targets.ts's `GigsEmpty`). It does
 * nothing about this window, and cannot: an unhydrated store answers
 * `[]` honestly, so Gigs.tsx really does render "No gigs yet" and the
 * branch really is agreeing with the screen. Only a wait fixes a
 * precondition, which is what this function is.
 * Observed directly: the first `help:test` run against this stack took
 * `no-gigs-yet` on an account of 396 gigs, before hydration had caught
 * up — the account was never the problem, the wait was missing.
 *
 * The *other* half of the precondition — that the account has a gig to
 * hydrate at all — is `ensureWalkableGig`'s job, called before this one
 * in `prepareHelpScenario`. This function only ever waits for something
 * the server already has; it does not create anything itself, which is
 * why it still returns immediately, honestly, when the server genuinely
 * has zero gigs (a user other than `dev@test.local`, or similar).
 *
 * Deliberately NOT a scenario step and not a longer debounce. A step
 * would make the tour wait too, on a page where the user is watching
 * nothing happen; a longer debounce would only widen a window that is
 * bounded by dataset size, not by a fixed delay.
 */
async function waitForGigsToHydrate(
  page: Page,
  request: APIRequestContext,
  baseURL: string,
): Promise<void> {
  const login = await request.post(`${baseURL}/api/auth/test-login`, {
    data: { email: "dev@test.local" },
  });
  if (!login.ok()) return; // No test auth here; the spec skips anyway.
  const { accessToken } = (await login.json()) as { accessToken: string };

  const listed = await request.get(`${baseURL}/api/gigs`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!listed.ok()) return;
  const { items } = (await listed.json()) as { items?: unknown[] };
  if (items === undefined || items.length === 0) return;

  // `gig-filters` rather than `gig-list`: the filter bar is
  // unconditional on `all.length > 0` (Gigs.tsx), so it is precisely
  // "the store has gigs in it now" and says nothing about what the saved
  // view leaves visible — that is the scenario's business, not this
  // function's.
  //
  // The budget covers two cold starts at once, which is why it is this
  // large. The first is the pull, which writes every gig, client,
  // expense, service and payment the account has. The second is the
  // dev server: this suite runs against `pnpm dev`, so vite serves the
  // App module graph unbundled and transforms each module on first
  // request — a cost that grows with the app and is paid by whichever
  // scenario happens to run first.
  //
  // 30s was not enough. Adding the Money tab (five modules to the graph)
  // pushed a run from 42s to 1.7m and produced two flaky scenarios, then
  // a DIFFERENT one on re-run — the giveaway that this is the shared
  // fixture timing out under whoever is unlucky, not any scenario being
  // wrong. Nothing here is broken; the app is simply still loading.
  //
  // Kept below the help project's 90s test timeout on purpose
  // (playwright.config.ts). A test cannot outlive its own timeout, so an
  // assertion budget at or above it can never expire — which is exactly
  // why the previous 30s-inside-30s reported a pending locator instead
  // of saying hydration timed out. If this needs raising again, the
  // question to ask is whether this suite should run against a build.
  await page.goto("/gigs");
  await expect(page.getByTestId("gig-filters")).toBeVisible({ timeout: 60_000 });
}

/**
 * Signs in and, if the scenario declares one, navigates to its
 * `startRoute` — the state every scenario's first step assumes.
 *
 * Calls `requireLocalTarget` itself rather than trusting every caller to
 * remember it separately: the entire reason this module exists is to
 * keep write-scenarios off production, so the one function that actually
 * gets a scenario running is where that has to be enforced, not an
 * opt-in a future spec could forget to also call.
 *
 * Signs in the same way settings.spec.ts's beforeEach does — there is
 * exactly one auth mechanism in this suite (test-auth.ts's
 * `requireTestAuth` plus the `test-signin` bypass button) and this must
 * not grow a second one.
 *
 * Resets the working week for every scenario, not just
 * `configure-working-hours` — matching how `resetGigListView` isn't
 * scoped to gig-list-only specs either. It touches one settings field
 * that no other scenario reads or asserts on, so there is nothing to
 * scope it against, and a future scenario that does share the field
 * gets the same guarantee for free instead of having to remember to ask.
 *
 * Resets the saved gig-list view for the same reason, and this one is
 * not hypothetical. `find-a-gig` branches on whether any row is showing,
 * and what decides that is not only the data but the persisted filters —
 * `gigListStatuses`, `gigListFrom/To`, `gigListHidePast`, all stored
 * server-side for this same shared dev user, all written by
 * `test:e2e`'s gig-list.spec.ts. A date range left behind by an earlier
 * suite empties a list of several hundred gigs, `find-a-gig` correctly
 * takes `gigs-hidden-by-filters`, and its `expectedCiBranches`
 * assertion fails — a scenario failing for something no scenario did.
 * Reusing gig-list.spec.ts's own helper rather than a second copy of
 * the PATCH keeps one definition of "the default view".
 *
 * Pins the one gig help walks into shape, unconditionally. That single
 * upsert does two jobs: it guarantees the account owns a gig at all —
 * `find-a-gig`'s `gigs-showing` precondition — and it puts a gig with a
 * known pay shape at the top of the default view, which is the row
 * `record-work`'s navigate step lands the runner on. See
 * `ensureWalkableGig`.
 *
 * Note what this is NOT: no help scenario creates, updates or deletes a
 * record, so nothing here is cleanup after a scenario. All three resets
 * pin a PRECONDITION that other suites (or a bare freshly migrated D1)
 * would otherwise leave unpredictable.
 */
export async function prepareHelpScenario(
  page: Page,
  request: APIRequestContext,
  baseURL: string,
  scenario: HelpScenario,
): Promise<void> {
  requireLocalTarget();
  await requireTestAuth(request, baseURL);
  await resetWorkingWeek(request, baseURL);
  await resetGigListView(request, baseURL);
  await ensureWalkableGig(request, baseURL);

  await page.goto("/login");
  await page.getByTestId("test-signin").click();
  await expect(page.getByTestId("tab-bar")).toBeVisible();

  // Before the startRoute navigation, not after: a scenario's first step
  // may run the instant that navigation settles, and the whole point is
  // that the store is already populated by then.
  await waitForGigsToHydrate(page, request, baseURL);

  if (scenario.startRoute !== undefined) {
    await page.goto(scenario.startRoute);
  }
}
