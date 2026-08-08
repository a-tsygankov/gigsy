import { test, expect, type APIRequestContext } from "@playwright/test";

// Signed-in flows via the test-auth bypass (POST /api/auth/test-login,
// which only exists outside production). Against deployments where
// it's disabled — e.g. PR previews proxying to the production worker —
// every spec here skips itself.

async function testAuthAvailable(request: APIRequestContext, baseURL: string) {
  try {
    const res = await request.get(`${baseURL}/api/auth/config`);
    if (!res.ok()) return false;
    const body = (await res.json()) as { testAuthEnabled?: boolean };
    return body.testAuthEnabled === true;
  } catch {
    return false;
  }
}

test.beforeEach(async ({ page, request, baseURL }) => {
  test.skip(
    !(await testAuthAvailable(request, baseURL!)),
    "test auth disabled on this deployment",
  );
  await page.goto("/login");
  await page.getByTestId("test-signin").click();
  await expect(page.getByTestId("tab-bar")).toBeVisible();
});

test("dev sign-in lands on the dashboard with navigation", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await expect(page.getByTestId("tile-unpaid")).toBeVisible();
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

  // Dashboard: the job shows in "waiting to be paid".
  await page.getByRole("link", { name: "Home" }).click();
  const row = page.getByTestId("unpaid-jobs").getByText("$190.00");
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
