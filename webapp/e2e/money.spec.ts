import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import {
  devAccessToken,
  requireTestAuth,
  resetGigListView,
} from "./helpers/test-auth.ts";
import { dateTimeField } from "./helpers/datetime-field.ts";

/**
 * What a gig is worth, everywhere it is stated.
 *
 * Every defect this file exists for had the same shape: the figure was
 * right on the screen you typed it into and wrong everywhere else.
 *
 *   - An hourly gig priced itself correctly on the work card and
 *     contributed NOTHING to any total, because the aggregates summed
 *     `amount_offered_cents` — which on an hourly gig is only an
 *     optional override, so a rated shift counted as zero (migration
 *     0014 and the `expected_cents` column are the fix).
 *   - A cancelled gig is supposed to leave the money while its record
 *     survives.
 *   - Paid-ness stopped being a status somebody set (migration 0015)
 *     and became a fact derived from the money, which means it has to
 *     appear and disappear on its own.
 *
 * So nothing here asserts on the form that owns the number. Each test
 * types a figure in one place and reads it back in another.
 *
 * DELTAS, not absolutes. The dev user is shared and every prior run
 * leaves gigs behind, so no total on this screen has a knowable value
 * — but the CHANGE one gig makes to it does. The baseline comes from
 * the API rather than from the tile, because the tile is the thing
 * under test and cannot also be the reference.
 */

/** "$1,234.56" → 123456. Null while the tile has not rendered yet, so
 *  `expect.poll` retries rather than throwing on the first pass. */
function moneyToCents(text: string | null): number | null {
  if (text === null) return null;
  const match = /-?[\d,]+\.\d{2}/.exec(text);
  if (match === null) return null;
  return Math.round(Number(match[0].replace(/,/g, "")) * 100);
}

/**
 * The server's own answer for "expected", unwindowed.
 *
 * `/api/reports/dashboard` with no bounds is exactly what the "All
 * open" option asks for, so this and the tile are answering the same
 * question — the only difference is that this one cannot be served
 * from a stale query cache.
 */
async function serverExpectedCents(
  request: APIRequestContext,
  baseURL: string,
  token: string,
): Promise<number> {
  const res = await request.get(`${baseURL}/api/reports/dashboard`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { expectedCents: number }).expectedCents;
}

/**
 * Wait for the dashboard's "Expected" tile to reach `cents`.
 *
 * Always from a fresh mount with "All open" chosen: the window is
 * component state, so navigating here resets it to 90 days, and a
 * dateless gig would fall outside that window and prove nothing.
 */
async function expectDashboardExpected(page: Page, cents: number): Promise<void> {
  await page.getByRole("link", { name: "Home" }).click();
  await expect(page.getByTestId("dashboard-window")).toBeVisible();
  await page.getByTestId("dashboard-window").selectOption("all");
  await expect(page.getByTestId("tile-expected")).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(async () => moneyToCents(await page.getByTestId("tile-expected").textContent()), {
      timeout: 30_000,
      message: `the dashboard's Expected tile never reached ${cents} cents`,
    })
    .toBe(cents);
}

/** The one row for `marker`, found by narrowing the list rather than by
 *  hunting through everything prior runs left behind. */
async function gigRow(page: Page, marker: string) {
  await page.getByRole("link", { name: "Gigs" }).click();
  await expect(page.getByRole("heading", { name: "Gigs" })).toBeVisible();
  await page.getByTestId("gig-search").fill(marker);
  await expect(page.getByTestId("gig-filter-count")).toHaveText(/Showing 1 of \d+/);
  return page.getByTestId("gig-list").getByRole("link").first();
}

test.beforeEach(async ({ page, request, baseURL }) => {
  await requireTestAuth(request, baseURL!);
  // Every test here narrows the list by typing in the search box, and a
  // status filter left behind by another spec would hide the row it is
  // looking for. Same reason gig-list.spec.ts does this.
  await resetGigListView(request, baseURL!);
  await page.goto("/login");
  await page.getByTestId("test-signin").click();
  await expect(page.getByTestId("tab-bar")).toBeVisible();
});

test.afterEach(async ({ request, baseURL }) => {
  await resetGigListView(request, baseURL!);
});

/**
 * An hourly gig is worth something to the TOTALS, not only to itself.
 *
 * 09:00 to 12:18 less an 18-minute break is 180 minutes, which at $50/h
 * is $150.00. The work card stating that was never the broken part —
 * e2e/signed-in.spec.ts already pins it. What broke is everything
 * downstream: the dashboard summed a column an hourly gig leaves null,
 * so this gig moved the "Expected" tile by exactly nothing, and the
 * list row showed no figure at all.
 *
 * The gig is left as a lead with no planned date on purpose. "All open"
 * drops the date bounds, so the only thing that can put $150 into the
 * total is the work log — there is no fee, and no plan to price.
 */
test("an hourly gig's earnings reach the dashboard total and its list row", async ({
  page,
  request,
  baseURL,
}) => {
  const token = await devAccessToken(request, baseURL!);
  const before = await serverExpectedCents(request, baseURL!, token);
  const marker = `hourly-total-${Date.now()}`;

  await page.getByRole("link", { name: "Gigs" }).click();
  await page.getByRole("link", { name: "Add gig" }).click();
  await page.getByTestId("gig-title").fill(marker);
  await page.getByTestId("gig-pay-type").selectOption("hourly");
  await page.getByTestId("gig-rate").fill("50");
  await page.getByTestId("gig-save").click();

  await expect(page.getByTestId("gig-work-card")).toBeVisible({ timeout: 15_000 });
  await dateTimeField(page, "gig-work-start").set("2027-03-04", "09:00");
  await dateTimeField(page, "gig-work-end").set("2027-03-04", "12:18");
  // Typed only once the previous write's receipt is on screen: the card
  // re-seeds its draft from the record whenever that record changes (a
  // documented trade in WorkCard.tsx), so a break typed while a save is
  // still in flight is replaced when the saved copy comes back.
  await expect(page.getByTestId("work-save-state")).toContainText(/Saved at/);
  await page.getByTestId("gig-break").fill("18");
  await page.getByTestId("gig-break").blur();
  await expect(page.getByTestId("gig-expected-pay")).toContainText("$150.00");

  // The totals are server-computed, so the work log has to arrive
  // before anything downstream can count it.
  await expect(page.getByTestId("sync-pending")).toBeHidden({ timeout: 20_000 });

  await expectDashboardExpected(page, before + 15_000);

  // …and on the row, which reads the same derived figure. Scoped to the
  // row and matched exactly: an unscoped `$150.00` would happily find
  // some other gig from some other run.
  const row = await gigRow(page, marker);
  await expect(row.getByText("$150.00", { exact: true })).toBeVisible();
});

/**
 * Cancelling is not deleting.
 *
 * A gig that fell through stops being money — it leaves the dashboard,
 * the reports and the availability projection (see availability.spec.ts
 * for that half) — but the record stays, because "we did not do this
 * job" is something the user may want to look at later.
 *
 * Both halves are asserted here, and the second is what stops the first
 * from passing for the wrong reason: a gig deleted outright would also
 * take its money off the tile.
 */
test("a cancelled gig leaves the money behind but keeps its record", async ({
  page,
  request,
  baseURL,
}) => {
  const token = await devAccessToken(request, baseURL!);
  const before = await serverExpectedCents(request, baseURL!, token);
  const marker = `cancel-money-${Date.now()}`;

  await page.getByRole("link", { name: "Gigs" }).click();
  await page.getByRole("link", { name: "Add gig" }).click();
  await page.getByTestId("gig-title").fill(marker);
  await page.getByTestId("gig-offered").fill("300");
  await page.getByTestId("gig-save").click();

  await expect(page.getByTestId("gig-work-card")).toBeVisible({ timeout: 15_000 });
  const gigUrl = page.url();
  await expect(page.getByTestId("sync-pending")).toBeHidden({ timeout: 20_000 });

  // It counts while it is still a live lead…
  await expectDashboardExpected(page, before + 30_000);

  await page.goto(gigUrl);
  await page.getByLabel("Status").selectOption("cancelled");
  await expect(page.getByTestId("status-pill")).toHaveText("cancelled");
  await expect(page.getByTestId("sync-pending")).toBeHidden({ timeout: 20_000 });

  // …and stops the moment it falls through.
  await expectDashboardExpected(page, before);

  // The record survives, still saying what happened to it.
  const row = await gigRow(page, marker);
  await expect(row.getByTestId("status-pill")).toHaveText("cancelled");
});

/**
 * The paid badge is a conclusion, not a setting.
 *
 * `paid` used to be a gig status somebody chose, sitting beside a
 * payment record that said the same thing independently — and the two
 * could disagree. Migration 0015 removed it: a gig is paid when what
 * has landed covers what is expected (lib/gig-pay.ts's `isPaid`), and
 * nothing anywhere sets that.
 *
 * So the same gig is asserted twice, with only the money changed
 * between them. A badge driven by the status would be wrong both times
 * — absent after the top-up, or present from the moment the gig was
 * marked completed.
 */
test("the paid badge follows the money, not the status", async ({ page }) => {
  const marker = `paid-badge-${Date.now()}`;

  await page.getByRole("link", { name: "Gigs" }).click();
  await page.getByRole("link", { name: "Add gig" }).click();
  await page.getByTestId("gig-title").fill(marker);
  await page.getByTestId("gig-offered").fill("200");
  await page.getByTestId("gig-paid").fill("50");
  await page.getByTestId("gig-save").click();

  await expect(page.getByTestId("gig-work-card")).toBeVisible({ timeout: 15_000 });
  const gigUrl = page.url();
  await page.getByLabel("Status").selectOption("completed");
  await expect(page.getByTestId("status-pill")).toHaveText("completed");

  // $50 of $200: completed, and emphatically not settled. Asserted with
  // the lifecycle pill present, so this cannot pass because the whole
  // badge pair failed to render.
  await expect(page.getByTestId("paid-badge")).toHaveCount(0);
  let row = await gigRow(page, marker);
  await expect(row.getByTestId("status-pill")).toHaveText("completed");
  await expect(row.getByTestId("paid-badge")).toHaveCount(0);

  // The balance lands. Nothing about the WORK changed.
  await page.goto(gigUrl);
  await page.getByTestId("gig-edit").click();
  await page.getByTestId("gig-paid").fill("200");
  await page.getByTestId("gig-save").click();

  await expect(page.getByTestId("gig-work-card")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("status-pill")).toHaveText("completed");
  await expect(page.getByTestId("paid-badge")).toBeVisible();

  row = await gigRow(page, marker);
  await expect(row.getByTestId("paid-badge")).toBeVisible();
});
