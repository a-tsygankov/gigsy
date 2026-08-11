import { test, expect, type Page } from "@playwright/test";
import { requireTestAuth } from "./helpers/test-auth.ts";

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
