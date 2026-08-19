import { test, expect, type Page } from "@playwright/test";
import { requireTestAuth, resetGigListView } from "./helpers/test-auth.ts";
import { dateTimeField } from "./helpers/datetime-field.ts";

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
 * The gig time control accepts any minute.
 *
 * The time half is a native `<input type="time">`, not a quarter-hour
 * `<select>` — there is no grid left to prove the containment of. What
 * still needs proving is what a time input does NOT give for free: it
 * starts disabled with no day to attach to, picking a day before the
 * hour fills a visible default rather than dropping the day, and
 * clearing empties the whole moment rather than half of it.
 */
test("the gig time control accepts any minute", async ({ page }) => {
  await page.getByRole("link", { name: "Gigs" }).click();
  await page.getByRole("link", { name: "Add gig" }).click();

  const when = dateTimeField(page, "gig-datetime");
  await when.expectValue("");
  await when.open();

  // No day yet, so there is nothing for a time to belong to.
  await expect(when.time).toBeDisabled();

  await when.pickDay("2026-09-14");
  await expect(when.time).toBeEnabled();

  // Picking a day before a time fills one in rather than dropping the
  // day on the floor.
  await expect(when.time).toHaveValue("09:00");

  // The point of the change: a minute that was never on the old grid.
  await when.setTime("14:18");
  await expect(when.time).toHaveValue("14:18");
  await when.expectValue("2026-09-14T14:18");

  // Asserted with the popover OPEN, which is when the widest thing on
  // the screen is on the screen. The filter row was caught doing exactly
  // this — a horizontally scrollable page also moves the fixed tab bar's
  // hit target, so it breaks navigation, not just looks.
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
  ).toBe(false);

  // Clearing empties the moment — a time alone is not one. Disabled
  // alone would pass a regression that disables the control but leaves
  // 14:18 sitting in it, so the value itself is asserted too.
  await when.clear();
  await expect(when.time).toBeDisabled();
  await expect(when.time).toHaveValue("");
  await when.expectValue("");
});

/**
 * The whole moment is reachable from the keyboard.
 *
 * Two native inputs were keyboard-operable for free. A popover is not:
 * Radix focuses the first focusable child on open, which is the previous
 * month arrow, leaving a keyboard user several tabs from any day — so
 * DateTimeField moves that focus onto the calendar itself, and this is
 * what says it still does.
 */
test("the date and time can be set without a pointer", async ({ page }) => {
  await page.goto("/gigs/new");
  const when = dateTimeField(page, "gig-datetime");

  await when.trigger.focus();
  await page.keyboard.press("Enter");
  await expect(when.calendar).toBeVisible();

  // Landed on a day, not on the month arrows.
  await expect(
    page.locator("td[data-day] button:focus"),
  ).toHaveCount(1);

  // Arrows walk the grid a week at a time; Enter takes the day, and the
  // 09:00 default fills in exactly as it does for a tap.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(when.trigger).toHaveAttribute("data-value", /T09:00$/);

  await when.time.focus();
  await page.keyboard.type("0930AM");
  await expect(when.trigger).toHaveAttribute("data-value", /T09:30$/);

  // Escape closes and hands focus back, so the tab order is not lost.
  await page.keyboard.press("Escape");
  await expect(when.calendar).toBeHidden();
  await expect(when.trigger).toBeFocused();
});
