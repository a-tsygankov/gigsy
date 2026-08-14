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
import { requireTestAuth } from "../helpers/test-auth.ts";
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

  await page.goto("/login");
  await page.getByTestId("test-signin").click();
  await expect(page.getByTestId("tab-bar")).toBeVisible();

  if (scenario.startRoute !== undefined) {
    await page.goto(scenario.startRoute);
  }
}
