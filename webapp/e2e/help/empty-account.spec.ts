import { expect, test } from "@playwright/test";
import { findAGig } from "../../src/help/scenarios/find-a-gig.ts";
import { recordWork } from "../../src/help/scenarios/record-work.ts";
import { requireLocalTarget } from "./help-fixtures.ts";
import { requireTestAuth } from "../helpers/test-auth.ts";
import { runHelpScenario } from "./help-runner.ts";

requireLocalTarget();

/**
 * The branch CI takes on nobody's account: "you have no gigs yet".
 *
 * `scenarios.spec.ts` runs `find-a-gig` and `record-work` through
 * `prepareHelpScenario`, which upserts a gig and then WAITS for it to
 * reach the client (`ensureWalkableGig`, `waitForGigsToHydrate`). That
 * is deliberate and correct — those scenarios declare
 * `expectedCiBranches: ["gigs-showing", ...]` — but it means the
 * suite's only account always owns a gig, and `no-gigs-yet` has never
 * been executed by anything. README §6's first warning, exactly: a
 * green run says nothing about branches CI does not take.
 *
 * That branch is worth executing because its condition changed. It was
 * `target-missing gig-filters`, and Gigs.tsx mounts the filter bar on
 * `all.length > 0` where `all` is `gigs.data ?? []` — an empty array
 * while the gig query is pending and again after it has errored. So the
 * branch that tells somebody "There are no gigs on this account" also
 * held while their list was loading. It now reads the "No gigs yet" box
 * (`gigs-empty`, help/targets.ts), which the screen renders only once
 * the query has answered.
 *
 * Note what this file does and does not prove, because the two halves
 * live apart on purpose. The WRONG states — pending and errored —
 * cannot be staged from here: reads go to Dexie, not the network, so
 * there is no request to stall or fail. Those are pinned in
 * `src/help/scenarios/gig-list-branches.test.ts`, which drives the same
 * real branch over a jsdom DOM and asserts nothing is taken. What this
 * file adds is the other half, and the half jsdom cannot give: that on
 * a real account with no gigs, in a real browser, the branch still
 * holds, the box it now reads has a real one to read, and both
 * scenarios walk it.
 *
 * The empty account is made, not found: the gig pull is served as an
 * empty list, and reads never touch the network anyway
 * (`OfflineDataService.listGigs`), so a context whose IndexedDB starts
 * empty stays empty. Nothing is written or deleted — this suite shares
 * a database with the rest of the e2e run, and the fixture gig other
 * specs depend on is left exactly where it is.
 *
 * Deliberately not using `prepareHelpScenario`: its hydration wait is
 * the precondition this test exists to withhold, and it would spend 60s
 * waiting for a filter bar that is never coming.
 */
async function openWithNoGigs(
  page: import("@playwright/test").Page,
  request: import("@playwright/test").APIRequestContext,
  baseURL: string,
  startRoute: string,
): Promise<void> {
  await requireTestAuth(request, baseURL);

  // Registered before sign-in so the first pull is already covered.
  // `**` on both sides: the client asks for `/api/gigs`, and this must
  // not accidentally swallow `/api/gigs/:id`-shaped writes from
  // elsewhere in the run — there are none on this page, and the empty
  // list is what the pull reads either way.
  await page.route("**/api/gigs**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: '{"items":[]}',
    }),
  );

  await page.goto("/login");
  await page.getByTestId("test-signin").click();
  await expect(page.getByTestId("tab-bar")).toBeVisible();
  await page.goto(startRoute);
}

test("the gig screen says there are no gigs, and says it with a box a tour can point at", async ({
  page,
  request,
  baseURL,
}) => {
  await openWithNoGigs(page, request, baseURL!, "/gigs");

  const empty = page.getByTestId("gigs-empty");
  await expect(empty).toBeVisible();
  await expect(empty).toContainText("No gigs yet");

  // `isVisible` (TourRenderer.ts) rules out anything a pixel wide or
  // less before it looks at anything else, so a tagged element with no
  // box would satisfy `getByTestId` here and still fail every branch
  // condition and every spotlight in the app.
  const box = await empty.boundingBox();
  expect(box!.width).toBeGreaterThan(1);
  expect(box!.height).toBeGreaterThan(1);

  // The three renders really are exclusive: this is the one where the
  // account owns nothing, so neither of the other two ids is present.
  await expect(page.getByTestId("gig-filters")).toHaveCount(0);
  await expect(page.getByTestId("gig-list")).toHaveCount(0);
});

for (const scenario of [findAGig, recordWork]) {
  test(`help: ${scenario.id} takes no-gigs-yet on an account with no gigs`, async ({
    page,
    request,
    baseURL,
  }) => {
    await openWithNoGigs(page, request, baseURL!, scenario.startRoute!);

    const trace = await runHelpScenario(page, scenario);

    // Not `expectedCiBranches`, which is the OTHER account's answer and
    // is asserted by scenarios.spec.ts. This is the branch that account
    // can never reach.
    expect(trace.branchesTaken).toEqual(["no-gigs-yet"]);
    expect(trace.stepsRun).toBeGreaterThan(0);
  });
}
