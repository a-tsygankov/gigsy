import { test, expect } from "@playwright/test";

/**
 * The stored theme is applied at boot — by the DEPLOYED page, under
 * the production Content-Security-Policy.
 *
 * This spec exists because of a bug nothing else could see. The theme
 * used to be applied by an inline <script> in index.html, and the CSP
 * that Pages Functions put on every response (functions/_middleware.ts,
 * `script-src 'self'`, no inline allowance) blocked it on every cold
 * start of the real app. `vite dev` serves no CSP, so every local run
 * and every unit test showed it working; the installed PWA reverted to
 * light on each launch and iOS painted a light status bar over a dark
 * app. The "preview smoke" CI job runs this file against the branch's
 * Pages preview — the one place the CSP is real — which is what makes
 * the assertion mean something.
 *
 * No sign-in: the boot script runs before any of that, and /login is
 * the one screen every deployment serves to everyone. The choice is
 * planted in localStorage before the page's own scripts run, exactly
 * as a previous visit would have left it.
 */

const CASES = [
  { stored: "dark", theme: "dark", chrome: "#0f172a" },
  { stored: "light", theme: "light", chrome: "#f8fafc" },
] as const;

for (const { stored, theme, chrome } of CASES) {
  test(`a stored "${stored}" theme is applied before the app boots`, async ({ page }) => {
    await page.addInitScript((value) => {
      window.localStorage.setItem("gigsy:theme", value);
    }, stored);
    await page.goto("/login");

    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    // The browser-chrome colour follows: this is what iOS paints the
    // status bar with in the installed app.
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", chrome);
  });
}

test("the theme is applied by a script the CSP admits, not an inline one", async ({
  page,
}) => {
  // A CSP violation surfaces as a console error naming the directive.
  // None may be logged for the theme — or for anything else on the
  // login page, which has no reason to run inline code.
  const violations: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && /Content Security Policy/i.test(message.text())) {
      violations.push(message.text());
    }
  });
  await page.goto("/login");
  await expect(page.locator("html")).toHaveAttribute("data-theme", /^(light|dark)$/);
  expect(violations).toEqual([]);
});

test("choosing nothing follows the device", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/login");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await page.emulateMedia({ colorScheme: "light" });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});
