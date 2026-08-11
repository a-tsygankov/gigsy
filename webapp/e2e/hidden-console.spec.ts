import { test, expect } from "@playwright/test";

// The hidden debug console: 3 taps on the app logo — on the login
// screen's wordmark pre-auth (the header logo shares the same
// trigger once signed in). These navigate to /login directly, which
// is where that wordmark actually lives; they used to rely on "/"
// redirecting there, and "/" now serves the landing page instead.
// Displays tier versions on open, app
// settings, client-side logs, worker-side logs. Worker-dependent
// values degrade gracefully (unreachable / 401 pre-login).

async function openConsole(page: import("@playwright/test").Page) {
  const logo = page.getByRole("heading", { name: "Gigsy" });
  await logo.click();
  await logo.click();
  await logo.click();
  return page.getByTestId("hidden-console");
}

test("3 taps on the logo open the hidden console", async ({ page }) => {
  await page.goto("/login");
  const consolePanel = await openConsole(page);
  await expect(consolePanel).toBeVisible();
});

test("fewer than 3 taps keep the console hidden", async ({ page }) => {
  await page.goto("/login");
  const logo = page.getByRole("heading", { name: "Gigsy" });
  await logo.click();
  await logo.click();
  await expect(page.getByTestId("hidden-console")).toHaveCount(0);
});

test("console shows all tier versions on open", async ({ page }) => {
  await page.goto("/login");
  await openConsole(page);

  // Client version is baked into the bundle — always a semver.
  await expect(page.getByTestId("version-client")).toContainText(/\d+\.\d+\.\d+/);
  // Worker + schema render either a live value or an explicit
  // unreachable/none marker — never blank.
  await expect(page.getByTestId("version-worker")).not.toBeEmpty();
  await expect(page.getByTestId("version-schema")).not.toBeEmpty();
});

test("console shows settings, client logs, and worker logs sections", async ({
  page,
}) => {
  await page.goto("/login");
  await openConsole(page);

  await expect(page.getByTestId("console-settings")).toBeVisible();
  // The app logs a startup line, so client logs are never empty.
  await expect(page.getByTestId("client-logs")).toContainText("app started");
  await expect(page.getByTestId("worker-logs")).toBeVisible();
});

test("console closes via its close button", async ({ page }) => {
  await page.goto("/login");
  const consolePanel = await openConsole(page);
  await expect(consolePanel).toBeVisible();

  await page.getByTestId("console-close").click();
  await expect(page.getByTestId("hidden-console")).toHaveCount(0);
});
