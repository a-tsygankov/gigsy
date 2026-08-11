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
  // GIS button iframe. Exactly one of the two ever exists, so the
  // or() locator stays unambiguous. Attachment (not visibility) is
  // the assertion: on per-PR preview origins Google mounts the
  // iframe but collapses it to hidden because the ephemeral origin
  // can't be on the OAuth client's authorized list (no wildcards).
  const unconfigured = page.getByTestId("login-unconfigured");
  const gisIframe = page.getByTestId("google-button-host").locator("iframe");
  await expect(unconfigured.or(gisIframe)).toBeAttached();
});

test("tab bar is hidden while signed out", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByTestId("tab-bar")).toHaveCount(0);
});

/**
 * The update bar must stay out of the way until there is genuinely a
 * newer build waiting.
 *
 * A false "update available" is worse than no bar at all: it trains
 * people to dismiss it, and then the real one gets dismissed too. The
 * first-ever service worker install is the case that would trip it —
 * a worker reaching "installed" with nothing controlling the page yet
 * is not an update, it is the app arriving.
 */
test("no update bar on an ordinary load", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByTestId("login-actions")).toBeVisible();

  // Give registration and any install a moment to settle before
  // asserting absence, or this passes for the wrong reason.
  await page.waitForTimeout(2000);
  await expect(page.getByTestId("update-bar")).toHaveCount(0);
});

test("no update bar after a reload, when the worker is already current", async ({
  page,
}) => {
  // The second load is the interesting one: a worker now controls the
  // page, so the controller check that suppresses the first-install
  // case is no longer doing the work.
  await page.goto("/login");
  await page.reload();
  await expect(page.getByTestId("login-actions")).toBeVisible();

  await page.waitForTimeout(2000);
  await expect(page.getByTestId("update-bar")).toHaveCount(0);
});
