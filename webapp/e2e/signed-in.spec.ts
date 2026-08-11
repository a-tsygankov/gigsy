import { test, expect } from "@playwright/test";
import { requireTestAuth } from "./helpers/test-auth.ts";

// Signed-in flows via the test-auth bypass (POST /api/auth/test-login,
// which only exists outside production). Where it's disabled these
// skip, unless the job set E2E_REQUIRE_AUTH — see helpers/test-auth.ts.

test.beforeEach(async ({ page, request, baseURL }) => {
  await requireTestAuth(request, baseURL!);
  await page.goto("/login");
  await page.getByTestId("test-signin").click();
  await expect(page.getByTestId("tab-bar")).toBeVisible();
});

test("dev sign-in lands on the dashboard with navigation", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await expect(page.getByTestId("tile-unpaid")).toBeVisible();
  // Calendar card renders in its disconnected state.
  await expect(page.getByTestId("calendar-section")).toContainText("Connect");
  await page.getByRole("link", { name: "Gigs" }).click();
  await expect(page.getByRole("heading", { name: "Gigs" })).toBeVisible();
  await page.getByRole("link", { name: "Clients" }).click();
  await expect(page.getByRole("heading", { name: "Clients" })).toBeVisible();
});

test("a completed unpaid gig with a service reaches the dashboard drill-down", async ({
  page,
}) => {
  const marker = `unpaid-booth-${Date.now()}`;

  // Create a completed gig: offered 200, paid 50.
  await page.getByRole("link", { name: "Gigs" }).click();
  await page.getByRole("link", { name: "Add gig" }).click();
  await page.getByLabel("Location").fill(marker);
  await page.getByLabel("Status").selectOption("completed");
  await page.getByLabel("Offered ($)").fill("200");
  await page.getByLabel("Paid ($)").fill("50");
  await page.getByRole("button", { name: "Save gig" }).click();

  // Add a service on it: offered 40, unpaid.
  await page.getByText(marker).click();
  await page.getByRole("link", { name: "+ Add service" }).click();
  await page.getByLabel("Description").fill("Overtime hour");
  await page.getByLabel("Offered ($)").fill("40");
  await page.getByRole("button", { name: "Save service" }).click();
  await expect(page.getByText("Overtime hour")).toBeVisible();

  // Wait for the outbox to drain (badge clears) — the dashboard is
  // server-computed, so the data must be synced before it can show.
  await expect(page.getByTestId("sync-pending")).toBeHidden({ timeout: 15_000 });

  // Dashboard: the job shows in "waiting to be paid". Prior e2e runs
  // accumulate rows on the shared dev user — assert on the first
  // match rather than a unique one.
  await page.getByRole("link", { name: "Home" }).click();
  const row = page.getByTestId("unpaid-jobs").getByText("$190.00").first();
  await expect(row).toBeVisible({ timeout: 15_000 });
});

test("a gig created while offline shows up instantly and drains on reconnect", async ({
  page,
  context,
}) => {
  const marker = `offline-booth-${Date.now()}`;

  await page.getByRole("link", { name: "Gigs" }).click();
  await expect(page.getByRole("heading", { name: "Gigs" })).toBeVisible();

  await context.setOffline(true);

  await page.getByRole("link", { name: "Add gig" }).click();
  await page.getByLabel("Location").fill(marker);
  await page.getByRole("button", { name: "Save gig" }).click();

  // Local-first: the gig is on the list with zero network, and the
  // header shows we're offline with unsynced work.
  await expect(page.getByText(marker)).toBeVisible();
  await expect(page.getByTestId("sync-offline")).toBeVisible();

  await context.setOffline(false);

  // Reconnect → the outbox drains → all badges clear, the gig stays.
  await expect(page.getByTestId("sync-offline")).toBeHidden({ timeout: 15_000 });
  await expect(page.getByTestId("sync-pending")).toBeHidden({ timeout: 15_000 });
  await expect(page.getByText(marker)).toBeVisible();
});

// Reopening the app when the server can't be reached used to hang on
// the startup screen (fetch has no default timeout) and then bounce to
// /login — even though the whole ledger is local and the session was
// still valid. These drive the API-unreachable path directly; a true
// offline reload also needs the service worker, which only exists in a
// production build.
test("reopening with the API unreachable lands in the app, not the login screen", async ({
  page,
  context,
}) => {
  await expect(page.getByTestId("tab-bar")).toBeVisible();

  await context.route("**/api/**", (route) => route.abort());
  await page.reload();

  await expect(page.getByTestId("tab-bar")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("link", { name: "Gigs" }).click();
  await expect(page.getByRole("heading", { name: "Gigs" })).toBeVisible();

  await context.unroute("**/api/**");
});

test("a hung refresh cannot freeze startup indefinitely", async ({ page, context }) => {
  await expect(page.getByTestId("tab-bar")).toBeVisible();

  // A connection that accepts but never answers — a phone waking onto
  // a captive-portal Wi-Fi. Without the abort timeout this never
  // resolves and the app sits on the splash forever.
  await context.route("**/api/auth/refresh", async () => {
    await new Promise((resolve) => setTimeout(resolve, 60_000));
  });

  await page.reload();
  await expect(page.getByTestId("splash")).toBeVisible();
  await expect(page.getByTestId("splash-status")).toBeVisible();
  // Bounded by the 8s refresh timeout, not by the hung request.
  await expect(page.getByTestId("tab-bar")).toBeVisible({ timeout: 25_000 });

  await context.unroute("**/api/auth/refresh");
});

/**
 * Phase 9: a gig's own length (which the calendar then honours) and an
 * expense the client is expected to cover.
 *
 * This test used to save and read straight back, which proved only
 * that Dexie kept the value — and it passed happily for months while
 * neither field was reaching the server at all, because the outbox
 * payload omitted both. So each half now drains the outbox and
 * reloads, forcing the pull that overwrites the local copy with the
 * server's. That reload is the step that used to erase the evidence.
 */
test("a gig duration and a billable expense survive a server round-trip", async ({
  page,
}) => {
  const marker = `dur-booth-${Date.now()}`;

  await page.getByRole("link", { name: "Gigs" }).click();
  await page.getByRole("link", { name: "Add gig" }).click();
  await page.getByLabel("Location").fill(marker);
  await page.getByTestId("gig-duration").selectOption("180");
  await page.getByRole("button", { name: "Save gig" }).click();

  // Let the save land first: click() returns once the click is
  // dispatched, so reloading straight after cancels the write.
  await expect(page.getByText(marker)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("sync-pending")).toBeHidden({ timeout: 20_000 });
  await page.reload();

  await page.getByText(marker).click();
  await expect(page.getByTestId("gig-duration")).toHaveValue("180");

  // …and an expense flagged as the client's to cover.
  await page.getByRole("link", { name: "Expenses" }).click();
  await page.getByRole("link", { name: "Add expense" }).click();
  await page.getByLabel("Amount ($)").fill("18.75");
  await page.getByLabel("Category").fill(marker);
  await page.getByTestId("expense-reimbursable").check();
  await page.getByRole("button", { name: "Save expense" }).click();

  await expect(page.getByText(marker).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("sync-pending")).toBeHidden({ timeout: 20_000 });
  await page.reload();

  await page.getByText(marker).first().click();
  await expect(page.getByTestId("expense-reimbursable")).toBeChecked();
});

// Editing a gig then reopening it used to show the pre-edit values:
// save invalidated the LIST query but not the single-gig one, and the
// 30s staleTime happily served the old copy.
test("reopening a just-edited gig shows the new values", async ({ page }) => {
  const marker = `stale-check-${Date.now()}`;

  await page.getByRole("link", { name: "Gigs" }).click();
  await page.getByRole("link", { name: "Add gig" }).click();
  await page.getByLabel("Location").fill(marker);
  await page.getByRole("button", { name: "Save gig" }).click();
  await expect(page.getByText(marker)).toBeVisible({ timeout: 15_000 });

  // Edit it: change the duration, save, reopen immediately.
  await page.getByText(marker).click();
  await page.getByTestId("gig-duration").selectOption("300");
  await page.getByRole("button", { name: "Save gig" }).click();
  await expect(page.getByText(marker)).toBeVisible({ timeout: 15_000 });

  await page.getByText(marker).click();
  await expect(page.getByTestId("gig-duration")).toHaveValue("300");
});

/**
 * A gig's optional title, proven past Dexie. The same trap as the
 * duration: saving and reading straight back only shows the local copy
 * kept it, so this drains the outbox and reloads, forcing the pull that
 * replaces the local gig with the server's.
 *
 * The list assertion here is only that the gig survived the round-trip;
 * that the heading is the title is covered by gig-list.spec.ts.
 */
test("a gig title survives a server round-trip", async ({ page }) => {
  const marker = `title-booth-${Date.now()}`;
  const title = `Costco tasting ${Date.now()}`;

  await page.getByRole("link", { name: "Gigs" }).click();
  await page.getByRole("link", { name: "Add gig" }).click();
  await page.getByLabel("Location").fill(marker);
  await page.getByTestId("gig-title").fill(title);
  await page.getByRole("button", { name: "Save gig" }).click();

  // Let the save land before reloading — click() returns on dispatch.
  await expect(page.getByText(marker)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("sync-pending")).toBeHidden({ timeout: 20_000 });
  await page.reload();

  // The list is now populated from the server copy.
  await expect(page.getByText(marker)).toBeVisible({ timeout: 15_000 });
  await page.getByText(marker).click();
  await expect(page.getByTestId("gig-title")).toHaveValue(title);
});

test("the time field offers quarter hours but preserves captured minutes", async ({
  page,
}) => {
  await page.getByRole("link", { name: "Gigs" }).click();
  await page.getByRole("link", { name: "Add gig" }).click();

  // The picker steps in 15-minute increments.
  await expect(page.getByLabel("Date & time")).toHaveAttribute("step", "900");

  // …but a value that did not come from the picker survives a save.
  // This is what an email/photo capture produces.
  const marker = `odd-minutes-${Date.now()}`;
  await page.getByLabel("Location").fill(marker);
  await page.getByLabel("Date & time").fill("2027-03-04T10:07");
  await page.getByRole("button", { name: "Save gig" }).click();
  await expect(page.getByText(marker)).toBeVisible({ timeout: 15_000 });

  await page.getByText(marker).click();
  await expect(page.getByLabel("Date & time")).toHaveValue("2027-03-04T10:07");
});

/**
 * The dot has to be on the RIGHT row. An earlier version of this test
 * asserted only that some dot existed somewhere on the list, which is
 * why it stayed green while the query cached the pending id set under
 * the pending COUNT: after a drain, a second offline edit reused the
 * id set from the first one and marked a gig that had already synced.
 * Hence the second half — two rows, two counts of 1, different gigs.
 */
test("a gig with unsent changes is marked, and the mark clears on sync", async ({
  page,
  context,
}) => {
  const first = `dot-check-a-${Date.now()}`;
  const second = `dot-check-b-${Date.now()}`;
  const rowFor = (marker: string) => page.locator("a", { hasText: marker });

  await page.getByRole("link", { name: "Gigs" }).click();
  await context.setOffline(true);
  await page.getByRole("link", { name: "Add gig" }).click();
  await page.getByLabel("Location").fill(first);
  await page.getByRole("button", { name: "Save gig" }).click();

  await expect(page.getByText(first)).toBeVisible();
  await expect(rowFor(first).getByTestId("gig-unsynced")).toBeVisible();

  await context.setOffline(false);
  await expect(page.getByTestId("sync-pending")).toBeHidden({ timeout: 20_000 });
  await expect(page.getByTestId("gig-unsynced")).toHaveCount(0, {
    timeout: 20_000,
  });

  // Second offline edit, different gig, same pending count as before.
  await context.setOffline(true);
  await page.getByRole("link", { name: "Add gig" }).click();
  await page.getByLabel("Location").fill(second);
  await page.getByRole("button", { name: "Save gig" }).click();

  await expect(page.getByText(second)).toBeVisible();
  await expect(rowFor(second).getByTestId("gig-unsynced")).toBeVisible();
  await expect(rowFor(first).getByTestId("gig-unsynced")).toHaveCount(0);

  await context.setOffline(false);
  await expect(page.getByTestId("sync-pending")).toBeHidden({ timeout: 20_000 });
  await expect(page.getByTestId("gig-unsynced")).toHaveCount(0, {
    timeout: 20_000,
  });
});
