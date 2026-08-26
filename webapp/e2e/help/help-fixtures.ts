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
import { RECORD_WORK_GIG_ID } from "../../src/help/scenarios/record-work.ts";
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

/**
 * Title marker for the gig `ensureAtLeastOneGig` plants. Distinct enough
 * that anyone who finds one of these in a dev account — locally or in
 * CI — knows immediately it came from this fixture and not from a human
 * or a scenario. Also doubles as an idempotency check on its own: see
 * `ensureAtLeastOneGig`.
 */
const SEEDED_GIG_TITLE = "[help-fixtures] seeded so find-a-gig has a row";

/**
 * Guarantee the account owns at least one gig, seeding one through the
 * API when it owns none.
 *
 * `find-a-gig`'s `expectedCiBranches: ["gigs-showing"]` used to hold only
 * by accident of CI step ordering: `test:e2e` runs before `help:test` in
 * `webapp-e2e-full` (deploy.yml) and plants several hundred gigs first,
 * so `help:test` never actually ran against the state it needs to
 * handle. Point it at a freshly migrated D1 — alone, or if those steps
 * are ever reordered — and the account has zero gigs, `find-a-gig`
 * correctly takes `no-gigs-yet`, and the branch assertion fails: a
 * missing precondition reading like a scenario bug. This closes that gap
 * by making the precondition true itself instead of hoping something
 * upstream already made it true.
 *
 * Idempotent and bounded, not "create a gig every run": it lists first
 * and only calls `PUT /api/gigs/:id` when the account has none at all.
 * Every CI run after the first, and every developer machine with real
 * data on it (this account has several hundred), sees a non-empty list
 * and this is a no-op — it does not matter whether an existing gig is
 * one this function planted earlier or one a human or another suite
 * wrote; "any gig" is all `find-a-gig`'s `gigs-showing` branch needs.
 *
 * Through the API, matching `resetWorkingWeek` and `resetGigListView` in
 * this same file: a token from `POST /api/auth/test-login`, then the
 * REST call — `PUT /api/gigs/:id` with a fresh UUID, per how `GigEdit.tsx`
 * creates a gig and what `backend/src/domain/schemas.ts`'s `GigInput`
 * actually requires (nothing beyond `status` and `source`, both
 * defaulted). `SEEDED_GIG_TITLE` marks provenance for whoever finds it.
 *
 * This is a fixture pinning a precondition, not a scenario writing data
 * — the same distinction `resetWorkingWeek` and `resetGigListView`
 * already draw. Phase 13's rule that no *scenario* creates, updates or
 * deletes a record is untouched: `find-a-gig` still only walks the
 * screen and stops at a row. What changed is which layer guarantees the
 * row exists to walk to.
 */
async function ensureAtLeastOneGig(request: APIRequestContext, baseURL: string): Promise<void> {
  const login = await request.post(`${baseURL}/api/auth/test-login`, {
    data: { email: "dev@test.local" },
  });
  if (!login.ok()) return; // No test auth here; the spec skips anyway.
  const { accessToken } = (await login.json()) as { accessToken: string };
  const headers = { authorization: `Bearer ${accessToken}` };

  const listed = await request.get(`${baseURL}/api/gigs`, { headers });
  if (!listed.ok()) return;
  const { items } = (await listed.json()) as { items?: unknown[] };
  if (items === undefined || items.length > 0) return; // Already has gigs — no-op.

  await request.put(`${baseURL}/api/gigs/${crypto.randomUUID()}`, {
    headers,
    data: { title: SEEDED_GIG_TITLE, status: "lead", source: "manual" },
  });
}

/** Title marker for the `record-work` fixture gig, matching
 *  `SEEDED_GIG_TITLE`'s purpose above for a different scenario. */
const RECORD_WORK_GIG_TITLE = "[help-fixtures] record-work's own gig — do not edit";

/**
 * Upsert `record-work`'s one gig into a known shape, every run.
 *
 * Unlike `ensureAtLeastOneGig`, this is not "seed one if the account has
 * none" — it is "make THIS id mean this" unconditionally, the same
 * `resetWorkingWeek` pattern for the same reason: `record-work` does not
 * find its gig through the list the way `find-a-gig` hands one over
 * (see that scenario's header on why no scenario can point at "a row"),
 * it starts on this fixed id directly (`RECORD_WORK_GIG_ID`,
 * `record-work.ts`'s `startRoute`). A PUT with the same id replaces the
 * record (`backend/src/routes/gigs.ts`), so re-running this after a
 * previous `record-work` pass — which writes work-log fields onto this
 * exact gig — resets it rather than accumulating whatever the last run
 * left behind.
 *
 * `payType: "hourly"` is load-bearing, not a random choice: WorkCard's
 * `GigOverride` control only renders on an hourly gig
 * (`WorkCard.tsx`'s `isHourly && <HourlyOverride ...>`), so a fixed-fee
 * fixture would leave that scenario step's target permanently
 * unresolved. `status: "confirmed"` and a real `dateTime` keep the gig
 * off any "needs a date" empty state the rest of the screen might show;
 * `workStartedAt`/`workEndedAt` stay unset so Start renders enabled and
 * Stop disabled, same as WorkCard.tsx's own guard on a not-yet-started
 * gig — a highlight step never clicks either one, but there is no
 * reason to start the fixture off in a state its own screen wouldn't
 * reach on its own.
 */
async function ensureRecordWorkGig(request: APIRequestContext, baseURL: string): Promise<void> {
  const login = await request.post(`${baseURL}/api/auth/test-login`, {
    data: { email: "dev@test.local" },
  });
  if (!login.ok()) return; // No test auth here; the spec skips anyway.
  const { accessToken } = (await login.json()) as { accessToken: string };

  await request.put(`${baseURL}/api/gigs/${RECORD_WORK_GIG_ID}`, {
    headers: { authorization: `Bearer ${accessToken}` },
    data: {
      title: RECORD_WORK_GIG_TITLE,
      status: "confirmed",
      dateTime: Date.now() + 24 * 60 * 60 * 1000,
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

const SEEDED_PAYMENT_NOTES = "[help-fixtures] seeded so find-a-payment has a row";

/**
 * Guarantee the account owns at least one payment, seeding one when it
 * owns none. `ensureAtLeastOneGig`'s reasoning applies unchanged, one
 * entity over: `find-a-payment` declares
 * `expectedCiBranches: ["payments-showing"]`, and against a freshly
 * migrated D1 the account has no payments, the scenario correctly takes
 * `no-payments-yet`, and the branch assertion fails — a missing
 * precondition reading like a scenario bug.
 *
 * `amountCents` is `positiveCents` (domain/schemas.ts), so a zero would
 * be refused; everything else on `PaymentInput` is nullish. No
 * allocation is created with it, which is deliberate rather than
 * incidental: an unallocated payment is a legitimate state the product
 * added the Money tab to make reachable at all, and it is the state the
 * scenario's own copy calls "the pile that needs you".
 */
async function ensureAtLeastOnePayment(
  request: APIRequestContext,
  baseURL: string,
): Promise<void> {
  const login = await request.post(`${baseURL}/api/auth/test-login`, {
    data: { email: "dev@test.local" },
  });
  if (!login.ok()) return; // No test auth here; the spec skips anyway.
  const { accessToken } = (await login.json()) as { accessToken: string };
  const headers = { authorization: `Bearer ${accessToken}` };

  const listed = await request.get(`${baseURL}/api/payments`, { headers });
  if (!listed.ok()) return;
  const { items } = (await listed.json()) as { items?: unknown[] };
  if (items === undefined || items.length > 0) return; // Already has payments.

  await request.put(`${baseURL}/api/payments/${crypto.randomUUID()}`, {
    headers,
    data: { amountCents: 12_500, paidAt: Date.now(), notes: SEEDED_PAYMENT_NOTES },
  });
}

/**
 * Wait for the FIRST pull to finish, before anything navigates.
 *
 * This exists because of a failure that looks like slowness and is not.
 * `SyncEngine.pull()` awaits its entities in series — gigs, clients,
 * expenses, services, payments, allocations — and every `page.goto`
 * is a full reload that abandons whichever one is in flight. That
 * alone would be survivable, because the next load pulls again. What
 * makes it fatal is `auth-store.ts`: refresh tokens ROTATE and are
 * consumed on use, so reloading three times in quick succession can
 * outrun the rotation being persisted, and every pull after that gets
 * a 401. Observed directly: `GET /api/gigs` returned 401 on each load
 * after the first, and the payments list sat on "No payments yet" for
 * a full 60s while the account had 45 of them.
 *
 * So the only reliably populated window is the one BEFORE the first
 * reload, and everything the suite reads has to land inside it. That
 * is not a new constraint — it is why `find-a-gig` works at all today:
 * gigs are entity one and get written in the first few hundred
 * milliseconds, while payments are entity five and never made it.
 * The same window is what the file's own note above about the Money
 * tab "producing two flaky scenarios, then a DIFFERENT one on re-run"
 * was really describing.
 *
 * Waiting on the payments store rather than on gigs is what makes this
 * a guarantee instead of a coincidence: payments are the fifth of six
 * entities, so their presence proves the four before them landed too.
 *
 * Read straight out of IndexedDB rather than off a rendered list, for
 * the reason the whole problem exists: a DOM check would need a
 * navigation to the screen that shows it, and a navigation is the
 * thing being avoided. `GigsyUserDB` is named `gigsy-user-${userId}`
 * (lib/db.ts), which is why this looks the database up by prefix
 * rather than by name — the fixture has no reason to know the id.
 *
 * Returns honestly and immediately when the server has no payments at
 * all: there is then nothing to wait for, `ensureAtLeastOnePayment`
 * has already had its chance to seed one, and blocking here would turn
 * an empty account into a timeout instead of a scenario correctly
 * taking its own empty branch.
 */
async function waitForInitialPull(
  page: Page,
  request: APIRequestContext,
  baseURL: string,
): Promise<void> {
  const login = await request.post(`${baseURL}/api/auth/test-login`, {
    data: { email: "dev@test.local" },
  });
  if (!login.ok()) return; // No test auth here; the spec skips anyway.
  const { accessToken } = (await login.json()) as { accessToken: string };

  const listed = await request.get(`${baseURL}/api/payments`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!listed.ok()) return;
  const { items } = (await listed.json()) as { items?: unknown[] };
  if (items === undefined || items.length === 0) return;

  // Same 60s budget, and the same reason as the gig wait below: two
  // cold starts, one of them vite serving the module graph unbundled.
  await expect
    .poll(
      async () =>
        await page.evaluate(async () => {
          const dbs = await indexedDB.databases();
          const name = dbs
            .map((d) => d.name)
            .find((n) => n !== undefined && n.startsWith("gigsy-user-"));
          if (name === undefined) return 0;
          const db = await new Promise<IDBDatabase | null>((resolve) => {
            const open = indexedDB.open(name);
            open.onsuccess = () => resolve(open.result);
            open.onerror = () => resolve(null);
          });
          if (db === null) return 0;
          if (!db.objectStoreNames.contains("payments")) {
            db.close();
            return 0;
          }
          const count = await new Promise<number>((resolve) => {
            const req = db.transaction("payments", "readonly").objectStore("payments").count();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(0);
          });
          db.close();
          return count;
        }),
      { timeout: 60_000 },
    )
    .toBeGreaterThan(0);
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
 * `target-missing gig-filters` condition is *correct* during that
 * window, so the settle-then-recheck debounce in help-runner.ts does not
 * save it — it commits to `no-gigs-yet` and every target on the branch
 * that matters (`gig-search`, `gig-filters-toggle`, `gig-list`) goes
 * unresolved, which the README's §6 warns turns them into prose.
 * Observed directly: the first `help:test` run against this stack took
 * `no-gigs-yet` on an account of 396 gigs, before hydration had caught
 * up — the account was never the problem, the wait was missing.
 *
 * The *other* half of the precondition — that the account has a gig to
 * hydrate at all — is `ensureAtLeastOneGig`'s job, called before this
 * one in `prepareHelpScenario`. This function only ever waits for
 * something the server already has; it does not create anything itself,
 * which is why it still returns immediately, honestly, when the server
 * genuinely has zero gigs (a broken call to `ensureAtLeastOneGig`, a
 * user other than `dev@test.local`, or similar).
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
 * Guarantees the account has a gig at all, before worrying about which
 * ones are visible: `ensureAtLeastOneGig` seeds exactly one, and only
 * when the account has none. Without it, `gigs-showing` was true only
 * because some *other* CI job happened to run first and leave gigs
 * behind — a dependency this fixture now removes by making the
 * precondition true itself.
 *
 * Pins `record-work`'s own gig into shape for the same reason, and
 * unconditionally like `resetWorkingWeek` rather than "only if missing"
 * like `ensureAtLeastOneGig`: `record-work` starts on one fixed id
 * (`RECORD_WORK_GIG_ID`) rather than finding a gig through the list, so
 * a stale copy left mid-shift by an earlier `record-work` run — a start
 * stamp with no stop, an override already set — is exactly the kind of
 * leftover state a later run must not inherit.
 *
 * Seeds a payment on the same "only if the account has none" terms as
 * `ensureAtLeastOneGig`, for `find-a-payment`'s `payments-showing`
 * branch, and then waits for the first pull to actually finish before
 * navigating anywhere — see `waitForInitialPull`, which is where the
 * reason lives and is worth reading, because it is not a timing tweak:
 * reloads consume rotating refresh tokens, so the window before the
 * first one is the only window in which a pull reliably completes.
 *
 * Note what this is NOT: no help scenario creates, updates or deletes a
 * record, so nothing here is cleanup after a scenario. Every reset here
 * pins a PRECONDITION that other suites (or a bare freshly migrated D1)
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
  await ensureAtLeastOneGig(request, baseURL);
  await ensureRecordWorkGig(request, baseURL);
  await ensureAtLeastOnePayment(request, baseURL);

  await page.goto("/login");
  await page.getByTestId("test-signin").click();
  await expect(page.getByTestId("tab-bar")).toBeVisible();

  // Before any navigation, and before the gig wait below — this is the
  // one window in which a pull runs to completion (see its header).
  // Ungated, unlike the payments seed it pairs with: every scenario
  // benefits from reading a fully populated store rather than one that
  // happens to contain whichever entities landed before the first
  // reload, which is the race this suite has been quietly running on.
  await waitForInitialPull(page, request, baseURL);

  // Before the startRoute navigation, not after: a scenario's first step
  // may run the instant that navigation settles, and the whole point is
  // that the store is already populated by then.
  await waitForGigsToHydrate(page, request, baseURL);

  if (scenario.startRoute !== undefined) {
    await page.goto(scenario.startRoute);
  }
}
