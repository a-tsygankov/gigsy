import { test, expect } from "@playwright/test";

// Phase 3 shell: unauthenticated visitors land on the login screen.
// The spec stays valid whether or not GOOGLE_CLIENT_ID is configured
// on the target deployment (button vs. explanatory notice).

test("unauthenticated visit redirects to the login screen", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page).toHaveTitle(/Gigsy/);
  await expect(page.getByRole("heading", { name: "Gigsy" })).toBeVisible();
  await expect(page.getByTestId("login-actions")).toBeVisible();
});

test("login screen shows a sign-in path (button or config notice)", async ({
  page,
}) => {
  await page.goto("/login");
  // Unconfigured deployment → explanatory notice; configured → the
  // rendered GIS iframe. Exactly one of the two ever exists, so the
  // or() locator stays unambiguous.
  const unconfigured = page.getByTestId("login-unconfigured");
  const gisIframe = page.getByTestId("google-button-host").locator("iframe");
  await expect(unconfigured.or(gisIframe)).toBeVisible();
});

test("tab bar is hidden while signed out", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByTestId("tab-bar")).toHaveCount(0);
});
