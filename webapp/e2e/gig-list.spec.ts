import { test, expect, type Page } from "@playwright/test";
import { requireTestAuth, resetGigListView } from "./helpers/test-auth.ts";

/**
 * The gig list's own controls (search, status chips, clear).
 *
 * The filter lives in the URL rather than component state, and the
 * back-and-forth test below is the reason: state would be gone the
 * moment you opened a gig, which is the one moment you always do.
 *
 * The shared dev user accumulates gigs from every prior run, so nothing
 * here may assume a count — each test plants its own unique marker and
 * asserts on that.
 */

test.beforeEach(async ({ page, request, baseURL }) => {
  await requireTestAuth(request, baseURL!);
  // The saved view outlives the browser context, so every test here
  // starts from an unfiltered list rather than from whatever the last
  // one left behind. Without it the order of this file changes its
  // results — a chip click toggles OFF when the filter is already on.
  await resetGigListView(request, baseURL!);
  await page.goto("/login");
  await page.getByTestId("test-signin").click();
  await expect(page.getByTestId("tab-bar")).toBeVisible();
});

/** A gig whose title is `marker`, left on the list and confirmed saved. */
async function addGig(page: Page, marker: string) {
  await page.getByRole("link", { name: "Gigs" }).click();
  await page.getByRole("link", { name: "Add gig" }).click();
  await page.getByTestId("gig-title").fill(marker);
  await page.getByRole("button", { name: "Save gig" }).click();
  // click() returns on dispatch, not on the write landing — acting
  // before the row appears cancels the save.
  await expect(page.getByText(marker)).toBeVisible({ timeout: 15_000 });
}

test("a search narrows the list and survives opening a gig", async ({ page }) => {
  const marker = `filter-me-${Date.now()}`;
  await addGig(page, marker);

  await page.getByTestId("gig-search").fill(marker);
  await expect(page.getByTestId("gig-filter-count")).toHaveText(/Showing 1 of \d+/);
  await expect(page.getByText(marker)).toBeVisible();

  // The whole point of URL state: open the gig, come back, still filtered.
  await page.getByText(marker).click();
  await expect(page.getByTestId("gig-title")).toHaveValue(marker);
  await page.goBack();

  await expect(page.getByRole("heading", { name: "Gigs" })).toBeVisible();
  await expect(page.getByTestId("gig-search")).toHaveValue(marker);
  await expect(page.getByTestId("gig-filter-count")).toHaveText(/Showing 1 of \d+/);
});

test("a filter matching nothing gets its own empty state", async ({ page }) => {
  await addGig(page, `empty-state-${Date.now()}`);

  await page.getByTestId("gig-search").fill(`no-such-gig-${Date.now()}`);

  await expect(page.getByText("No gigs match these filters")).toBeVisible();
  // Not the blank-slate state: the gigs exist, the filter hid them, and
  // offering "Add a gig" would answer a question nobody asked.
  await expect(page.getByText("No gigs yet")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Add a gig" })).toHaveCount(0);
});

test("a status filter reaches the URL and Clear filters removes it", async ({ page }) => {
  await addGig(page, `status-filter-${Date.now()}`);

  await page.getByTestId("gig-filters-toggle").click();
  await page.getByTestId("gig-status-lead").click();

  await expect(page).toHaveURL(/status=lead/);
  await expect(page.getByTestId("gig-status-lead")).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await page.getByTestId("gig-filters-clear").click();

  await expect(page).not.toHaveURL(/status=/);
  await expect(page.getByTestId("gig-status-lead")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(page.getByTestId("gig-filters-clear")).toHaveCount(0);
});

/**
 * The filter row overflowed a phone screen: Input and Select bake
 * `w-full` into their shell class, so the `w-36` passed to the sort
 * select lost to it in the stylesheet and the select refused to shrink.
 *
 * It broke more than looks. A horizontally scrollable page moves the
 * hit target for the fixed tab bar, so clicking "Clients" from the gig
 * list timed out — which is how CI found it, in a pre-existing
 * navigation test rather than any of the new ones.
 */
test("the gig list does not scroll sideways on a phone", async ({ page }) => {
  // Self-contained: the filter bar only renders once there is at least
  // one gig, and CI starts from an empty database.
  const marker = `overflow-${Date.now()}`;
  await page.getByRole("link", { name: "Gigs" }).click();
  await page.getByRole("link", { name: "Add gig" }).click();
  await page.getByLabel("Location").fill(marker);
  await page.getByRole("button", { name: "Save gig" }).click();
  await expect(page.getByText(marker)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("gig-filters")).toBeVisible({ timeout: 15_000 });

  const overflows = () =>
    page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );

  expect(await overflows()).toBe(false);

  // …and with the panel open, where the date inputs live.
  await page.getByTestId("gig-filters-toggle").click();
  await expect(page.getByTestId("gig-from")).toBeVisible();
  expect(await overflows()).toBe(false);

  // The tab bar must stay clickable, which is what the overflow broke.
  await page.getByRole("link", { name: "Clients" }).click();
  await expect(page.getByRole("heading", { name: "Clients" })).toBeVisible();
});

/**
 * The saved view (settings-backed).
 *
 * These cross the API on purpose — the unit tests already pin the
 * conversion rules, but only a round trip proves the preference
 * actually left the browser and came back.
 *
 * The panel's open/closed state is local to the component, so it shuts
 * again after every navigation, and the status chips live inside it.
 * Anything asserting on a chip has to open the panel first, or it is
 * asserting on an element that was never rendered — which is a pass
 * that means nothing and a failure that misleads.
 */
async function openFilters(page: Page) {
  await page.getByTestId("gig-filters-toggle").click();
  await expect(page.getByTestId("gig-status-filter")).toBeVisible();
}

// Other spec files share this dev user and list gigs too, so the reset
// runs on the way out as well as on the way in.
test.afterEach(async ({ request, baseURL }) => {
  await resetGigListView(request, baseURL!);
});

test("a status filter survives a reload, without a URL to carry it", async ({
  page,
}) => {
  await addGig(page, `persist-status-${Date.now()}`);

  await page.getByTestId("gig-filters-toggle").click();
  await page.getByTestId("gig-status-lead").click();
  await expect(page).toHaveURL(/status=lead/);
  await page.waitForTimeout(1000);

  // A bare URL: nothing in the address bar could restore this, so the
  // filter can only come back from the server.
  await page.goto("/gigs");
  await expect(page).toHaveURL(/status=lead/);
  await openFilters(page);
  await expect(page.getByTestId("gig-status-lead")).toHaveAttribute(
    "aria-pressed",
    "true",
  );

});

test("a shared link beats the saved view", async ({ page }) => {
  await addGig(page, `link-wins-${Date.now()}`);

  await page.getByTestId("gig-filters-toggle").click();
  await page.getByTestId("gig-status-lead").click();
  await expect(page).toHaveURL(/status=lead/);
  await page.waitForTimeout(1000);

  // Someone sends you a link to their paid gigs. It must mean that,
  // whatever you last left on screen.
  await page.goto("/gigs?status=paid");
  await expect(page).toHaveURL(/status=paid/);
  await expect(page).not.toHaveURL(/status=lead/);
  await openFilters(page);
  await expect(page.getByTestId("gig-status-lead")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(page.getByTestId("gig-status-paid")).toHaveAttribute(
    "aria-pressed",
    "true",
  );

});

test("Clear filters stays cleared after a reload", async ({ page }) => {
  // The regression this guards: seeding from settings on every empty
  // URL would put the filter straight back, so Clear would appear to do
  // nothing at all.
  await addGig(page, `clear-sticks-${Date.now()}`);

  await page.getByTestId("gig-filters-toggle").click();
  await page.getByTestId("gig-status-lead").click();
  await expect(page).toHaveURL(/status=lead/);
  await page.waitForTimeout(1000);

  await page.getByTestId("gig-filters-clear").click();
  await expect(page).not.toHaveURL(/status=/);
  await page.waitForTimeout(1000);

  await page.goto("/gigs");
  await expect(page).not.toHaveURL(/status=/);
  await openFilters(page);
  await expect(page.getByTestId("gig-status-lead")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
});

/**
 * Quarter-hour times.
 *
 * `step={900}` on the input was the original attempt and did not hold:
 * it drives the picker's increments and marks an off-grid value
 * `stepMismatch`, but the value stays whatever was entered and nothing
 * runs native form validation before saving. So this drives the field
 * the way a person would and checks the value that results, rather than
 * trusting the attribute to mean what it looks like it means.
 */
test("a gig time off the quarter-hour grid snaps when you leave the field", async ({
  page,
}) => {
  await page.getByRole("link", { name: "Gigs" }).click();
  await page.getByRole("link", { name: "Add gig" }).click();

  const when = page.getByTestId("gig-datetime");
  await when.fill("2026-09-14T10:07");
  // Still exactly what was entered — the attribute alone changes nothing.
  await expect(when).toHaveValue("2026-09-14T10:07");

  await when.blur();
  await expect(when).toHaveValue("2026-09-14T10:00");

  // Nearest, not down: 10:53 must become 11:00, not 10:45.
  await when.fill("2026-09-14T10:53");
  await when.blur();
  await expect(when).toHaveValue("2026-09-14T11:00");

  // And a value already on the grid is left alone.
  await when.fill("2026-09-14T14:30");
  await when.blur();
  await expect(when).toHaveValue("2026-09-14T14:30");
});
