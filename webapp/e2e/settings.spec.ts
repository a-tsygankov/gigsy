import { test, expect } from "@playwright/test";
import { requireTestAuth } from "./helpers/test-auth.ts";

// Settings (Phase 11 groundwork) and the push opt-in that completes
// Phase 10. Notification permission cannot be granted headlessly, so
// these cover the screen and its states, not the browser prompt.

test.beforeEach(async ({ page, request, baseURL }) => {
  await requireTestAuth(request, baseURL!);
  await page.goto("/login");
  await page.getByTestId("test-signin").click();
  await expect(page.getByTestId("tab-bar")).toBeVisible();
});

test("settings is reachable from the header and shows the account", async ({
  page,
}) => {
  await page.getByTestId("settings-link").click();

  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByTestId("settings-email")).toContainText("@");
});

test("app versions are visible without knowing the hidden console", async ({
  page,
}) => {
  await page.goto("/settings");

  const about = page.getByTestId("settings-about");
  await expect(about).toContainText("client");
  // The worker version proves it reached the API, not just package.json.
  await expect(about).toContainText("worker");
});

test("notifications either offer a toggle or explain why they can't", async ({
  page,
}) => {
  await page.goto("/settings");

  const section = page.getByTestId("settings-notifications");
  await expect(section).toBeVisible();

  // Exactly one of the two must be present: a way to turn them on, or
  // a reason it isn't possible here. Silence would be a dead end.
  await expect(
    page.getByTestId("push-toggle").or(page.getByTestId("push-unavailable")),
  ).toBeVisible();
});

test("signing out from settings returns to login", async ({ page }) => {
  await page.goto("/settings");
  await page.getByRole("button", { name: "Sign out" }).click();

  await expect(page).toHaveURL(/\/login$/);
});
