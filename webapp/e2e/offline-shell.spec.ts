import { test, expect } from "@playwright/test";

/**
 * Offline reopen against the REAL service worker.
 *
 * This exists because switching to `injectManifest` (Phase 10, to host
 * the push handler) made precaching our own code, and the first
 * hand-written worker silently lost the SPA navigation fallback that
 * `generateSW` had been adding. The app still built, still passed
 * every other test, and would no longer open offline.
 *
 * Only a production build has a service worker at all, so this runs
 * against `vite preview` and skips elsewhere.
 */
test.skip(
  process.env["E2E_PREVIEW"] !== "1",
  "needs a production build served by vite preview (E2E_PREVIEW=1)",
);
test("the installed app still opens with no connectivity", async ({ page, context }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Gigsy" })).toBeVisible();

  // Wait for the worker to control the page; precaching happens on
  // install, and reloading before that would prove nothing.
  await page.waitForFunction(
    () => navigator.serviceWorker.controller !== null,
    undefined,
    { timeout: 20_000 },
  );

  await context.setOffline(true);
  await page.reload();

  // The shell must come from the precache. Not the sign-in button:
  // that depends on /api/auth/config, which offline correctly cannot
  // answer — the app renders its "can't reach the server" state.
  await expect(page.getByRole("heading", { name: "Gigsy" })).toBeVisible({
    timeout: 20_000,
  });
  await context.setOffline(false);
});
