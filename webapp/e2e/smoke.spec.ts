import { test, expect } from "@playwright/test";

// Phase 0 smoke — the shell renders. Behavioural flows (auth, gig
// CRUD, capture) get their own specs from Phase 3 on.
test("shell renders", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/Gigsy/);
  await expect(page.getByRole("heading", { name: "Gigsy" })).toBeVisible();
  await expect(page.getByTestId("api-status")).toBeVisible();
});
