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

/**
 * Tapping the switch itself has to work.
 *
 * The input is `sr-only` (1x1px) and the switch you see is a sibling
 * span. Without a label around them, tapping the switch hit nothing:
 * every toggle in the app could only be operated via its separate text
 * label. On the settings rows that label is the whole setting name, big
 * enough to hide the bug for months. On the working-hours rows it is a
 * three-letter day, which is how it finally surfaced — "why can't I
 * switch Sun".
 *
 * So these click the PAINTED switch, never the testid (which resolves
 * to the hidden input and would pass either way).
 */
function paintedSwitch(page: import("@playwright/test").Page, testId: string) {
  return page.locator(`label:has([data-testid="${testId}"]) span[aria-hidden="true"]`).first();
}

test("tapping the switch itself toggles it, on a settings row", async ({ page }) => {
  await page.goto("/settings");

  const input = page.getByTestId("toggle-prefix");
  await expect(input).toBeAttached();
  const before = await input.isChecked();

  await paintedSwitch(page, "toggle-prefix").click();

  await expect(input).toBeChecked({ checked: !before });
});

test("tapping the switch itself toggles a working-hours day", async ({ page }) => {
  await page.goto("/settings");

  // Sunday: the row that surfaced this, and the one whose text label is
  // only three characters wide.
  const sunday = page.getByTestId("toggle-day-0");
  await expect(sunday).toBeAttached();
  const before = await sunday.isChecked();

  await paintedSwitch(page, "toggle-day-0").click();

  await expect(sunday).toBeChecked({ checked: !before });
});

/**
 * The forwarding address for email capture.
 *
 * Both outcomes are legitimate: an address when CAPTURE_EMAIL_DOMAIN
 * is configured, and a plain "not switched on" line when it is not.
 * Asserting the pair — rather than one of them — is what keeps this
 * honest on a deployment that has not enabled capture yet.
 */
test("capture either offers a forwarding address or says it is off", async ({
  page,
}) => {
  await page.goto("/settings");

  const section = page.getByTestId("settings-capture");
  await expect(section).toBeVisible();

  await expect(
    page.getByTestId("capture-address").or(page.getByTestId("capture-unconfigured")),
  ).toBeVisible({ timeout: 15_000 });

  // When there IS an address it must be this user's, in the form the
  // inbound handler parses.
  const value = page.getByTestId("capture-address-value");
  if (await value.isVisible().catch(() => false)) {
    await expect(value).toHaveText(/^u-[\w-]+@\S+$/);
  }
});

/**
 * The theme survives leaving Settings AND a full reload.
 *
 * Reported on the installed PWA as "dark theme is not saved on closing
 * Settings". It was saved; it was not APPLIED on the next launch,
 * because the pre-paint script was inline and the production CSP
 * blocked it (see e2e/theme.spec.ts, which proves the boot path on the
 * deployed page without signing in). This is the same journey from the
 * user's side: choose it here, go elsewhere, come back cold.
 */
test("a theme chosen here is still on after leaving and reloading", async ({ page }) => {
  await page.goto("/settings");
  await page.getByTestId("theme-dark").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  // The gear on Settings closes it (AppHeader.tsx's `closeSettings`):
  // back to the previous entry, or home when the screen was opened cold.
  await page.getByTestId("settings-link").click();
  await expect(page.getByTestId("tab-bar")).toBeVisible();
  await expect(page).not.toHaveURL(/\/(settings|login)$/);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await page.reload();
  // Still signed in — the theme is applied on the login page too, so
  // without this a lost session would pass the next line by accident.
  await expect(page.getByTestId("tab-bar")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#0f172a");

  // Put it back, so the next spec is not run dark by surprise.
  await page.goto("/settings");
  await page.getByTestId("theme-system").click();
});
