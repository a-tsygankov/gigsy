import { test, expect } from "@playwright/test";

/**
 * The landing page exists to satisfy Google's OAuth verification, which
 * requires a home page that is publicly accessible "and not just
 * accessible to your site's logged-in users", describes the app, and
 * links to the privacy policy.
 *
 * These are not decorative assertions. Each one maps to a documented
 * rejection reason, and every one of them is a property that a routing
 * change could quietly take away — which is exactly what happened
 * before, when "/" was a redirect to a sign-in box.
 *
 * Keep in step with docs/google-oauth-verification.md.
 */

test("the bare domain is public — no account, no redirect", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("landing")).toBeVisible();
  // The sign-in box is a destination here, never the greeting.
  await expect(page.getByTestId("login-actions")).toHaveCount(0);
});

test("the home page describes how Gigsy uses Google Calendar", async ({
  page,
}) => {
  // Reviewers compare the described behaviour against the scopes on the
  // consent screen. Both scopes have to be accounted for in prose, and
  // the read side has to be honest that it is free/busy only.
  await page.goto("/");
  const landing = page.getByTestId("landing");
  await expect(
    landing.getByRole("heading", { name: /Google Calendar/i }),
  ).toBeVisible();
  await expect(landing).toContainText(/free\/busy/i);
  await expect(landing).toContainText(/never event titles/i);
});

test("the privacy policy is reachable from the home page without signing in", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByTestId("landing-privacy-link").click();
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page.getByTestId("privacy-policy")).toBeVisible();
});

test("the home page renders with the API unreachable", async ({ page }) => {
  // "Your home page URL is unresponsive" is a rejection reason, and a
  // home page that waits on a fetch is one bad deploy away from being
  // exactly that. This is the guard on the page staying static.
  await page.route("**/api/**", (route) => route.abort());

  await page.goto("/");
  await expect(page.getByTestId("landing")).toBeVisible();
  await expect(page.getByTestId("landing-signin")).toBeVisible();
});
