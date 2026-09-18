import { test, expect } from "@playwright/test";
import { requireTestAuth, resetGigListView } from "./helpers/test-auth.ts";
import { dateTimeField } from "./helpers/datetime-field.ts";

/**
 * One form, two dates, two gigs (docs/superpowers/specs/2026-09-18-
 * gig-batches-design.md).
 *
 * The unit tests (screens/GigEdit.test.tsx) prove the form calls
 * `putGig` once per date with one shared `batchId`; what only a round
 * trip proves is that the "Also on" row is a real DateTimeField a person
 * can set, that the save lands on the LIST rather than on a gig (there
 * is no single "the gig" to open), and that both records actually come
 * back from the server as two rows.
 *
 * The shared dev user accumulates gigs from every prior run, so nothing
 * here may assume a count — the title carries a unique marker and the
 * assertion is on rows containing it.
 */

test.beforeEach(async ({ page, request, baseURL }) => {
  await requireTestAuth(request, baseURL!);
  // An unfiltered list, whatever the last spec left saved — the two
  // rows this test looks for are leads, and a saved status filter
  // could hide them (see gig-list.spec.ts).
  await resetGigListView(request, baseURL!);
  await page.goto("/login");
  await page.getByTestId("test-signin").click();
  await expect(page.getByTestId("tab-bar")).toBeVisible();
});

test.afterEach(async ({ request, baseURL }) => {
  await resetGigListView(request, baseURL!);
});

test("a gig with an Also-on date saves as two gigs and lands on the list", async ({
  page,
}) => {
  const marker = `Batch shift ${Date.now()}`;
  await page.goto("/gigs/new");
  await page.getByTestId("gig-title").fill(marker);

  // The primary date, through the real popover — helpers/datetime-
  // field.ts walks the calendar to the month and clicks the day.
  await dateTimeField(page, "gig-datetime").set("2026-10-05", "09:00");

  // One "Also on" row, a different day. Rows are numbered from 0 and
  // suffix the block's id, so the first row's DateTimeField is
  // `gig-extra-dates-0` and its popover controls hang off that.
  await expect(page.getByTestId("gig-extra-dates-0")).toHaveCount(0);
  await page.getByTestId("gig-extra-dates-add").click();
  await dateTimeField(page, "gig-extra-dates-0").set("2026-10-06", "09:00");
  await dateTimeField(page, "gig-extra-dates-0").expectValue("2026-10-06T09:00");

  await page.getByRole("button", { name: "Save gig" }).click();

  // Two gigs: no single one to open, so the list — not `/gigs/:id`.
  await expect(page).toHaveURL(/\/gigs$/, { timeout: 15_000 });
  await expect(page.getByText(marker)).toHaveCount(2, { timeout: 15_000 });
});

test("editing one of the pair offers no Also-on rows", async ({ page }) => {
  // Batches are made at creation only: the edit form is single-date.
  const marker = `Batch edit ${Date.now()}`;
  await page.goto("/gigs/new");
  await page.getByTestId("gig-title").fill(marker);
  await dateTimeField(page, "gig-datetime").set("2026-10-07", "09:00");
  await page.getByTestId("gig-extra-dates-add").click();
  await dateTimeField(page, "gig-extra-dates-0").set("2026-10-08", "09:00");
  await page.getByRole("button", { name: "Save gig" }).click();
  await expect(page).toHaveURL(/\/gigs$/, { timeout: 15_000 });
  await expect(page.getByText(marker)).toHaveCount(2, { timeout: 15_000 });

  await page.getByText(marker).first().click();
  await expect(page.getByTestId("gig-heading")).toHaveText(marker);
  await page.getByTestId("gig-edit").click();
  await expect(page.getByTestId("gig-datetime")).toBeVisible();
  await expect(page.getByTestId("gig-extra-dates-add")).toHaveCount(0);
});
