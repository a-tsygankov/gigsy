import { test, expect } from "@playwright/test";
import { requireTestAuth, resetGigListView } from "./helpers/test-auth.ts";

/**
 * A client that does not exist yet, named from inside the gig form
 * (docs/superpowers/specs/2026-09-19-client-create-and-match-design.md).
 *
 * The unit tests (screens/GigEdit.test.tsx) prove the form calls
 * `putClient` and then `putGig` with the new id; what only a round trip
 * proves is that the "New client…" option is a real `<option>` a person
 * can pick, that the name box it opens takes typing, and that the gig's
 * own screen — which looks the client up by id from the list the server
 * returns — shows the name that was typed.
 *
 * The shared dev user accumulates clients from every prior run, so the
 * name carries a unique marker and nothing here assumes a count.
 */

test.beforeEach(async ({ page, request, baseURL }) => {
  await requireTestAuth(request, baseURL!);
  await resetGigListView(request, baseURL!);
  await page.goto("/login");
  await page.getByTestId("test-signin").click();
  await expect(page.getByTestId("tab-bar")).toBeVisible();
});

test.afterEach(async ({ request, baseURL }) => {
  await resetGigListView(request, baseURL!);
});

test("picking New client… on the gig form creates the client with the gig", async ({
  page,
}) => {
  const clientName = `Agency ${Date.now()}`;
  await page.goto("/gigs/new");

  // The name box is not there until the option is picked.
  await expect(page.getByTestId("gig-client-new-name")).toHaveCount(0);
  await page.getByTestId("gig-client").selectOption("__new__");
  await expect(page.getByTestId("gig-client-new-name")).toBeVisible();
  await page.getByTestId("gig-client-new-name").fill(clientName);

  await page.getByRole("button", { name: "Save gig" }).click();

  // One gig: its hub, whose job card names the client by looking the
  // saved id up in the client list — so the row proves the client row
  // exists as well as the gig.
  await expect(page.getByTestId("gig-job-card")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("job-client")).toHaveText(clientName);
});

test("a blank new-client name is refused under the field and nothing is saved", async ({
  page,
}) => {
  await page.goto("/gigs/new");
  await page.getByTestId("gig-client").selectOption("__new__");
  await page.getByRole("button", { name: "Save gig" }).click();

  await expect(page.getByText("Give the new client a name.")).toBeVisible();
  // Still on the form.
  await expect(page).toHaveURL(/\/gigs\/new$/);
  await expect(page.getByTestId("gig-save")).toBeVisible();
});
