import { defineConfig, devices } from "@playwright/test";

// E2E target. Defaults to the production webapp; override via
// E2E_BASE_URL=http://localhost:5173 (with `pnpm dev` running) for
// local iteration. CI points this at the per-PR Pages preview URL.
const baseURL = process.env["E2E_BASE_URL"] ?? "https://gigsy-webapp.pages.dev";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false, // serialise — tests will share the prod D1
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 2 : 0,
  workers: 1,
  reporter: process.env["CI"] ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
    actionTimeout: 10_000,
  },
  projects: [
    {
      // Primary devices are phones — the whole suite runs at a
      // Chromium-based handset profile (viewport, touch, mobile UA).
      name: "chromium",
      use: { ...devices["Pixel 7"] },
      // Help scenarios have their own project: they write settings and
      // refuse to run anywhere but a local stack.
      testIgnore: /help\//,
    },
    {
      name: "help",
      use: { ...devices["Pixel 7"] },
      testMatch: /help\/.*\.spec\.ts/,
      // Longer than the 30s default because every scenario in this
      // project pays two cold starts before its first step: the initial
      // pull (`waitForGigsToHydrate` in help-fixtures.ts) and vite's
      // first transform of the App module graph, since this suite runs
      // against `pnpm dev` rather than a build.
      //
      // The 30s default was the real ceiling here, not the 30s the
      // fixture's own assertion asked for — a test cannot outlive its
      // timeout, so that assertion could never actually expire and the
      // failure surfaced as a pending-locator report instead. The
      // fixture now asks for 60s inside this 90s, so a genuine
      // hydration failure reports itself rather than the test clock.
      timeout: 90_000,
      // …and a matching budget for the assertions INSIDE that timeout.
      //
      // Raising the test timeout alone was an incomplete fix. Playwright's
      // default `expect` timeout is 5s and nothing here overrode it, so
      // every bare `toBeVisible()` in this project still had five seconds
      // to survive the same two cold starts the 90s exists for —
      // `reachability.spec.ts` alone has eleven. Reproduced locally: on
      // the first run against a freshly started dev server it failed at
      // `settings-help`, `Timeout: 5000ms`, then passed three times in a
      // row once warm.
      //
      // 15s is well inside the 90s test timeout, so a genuine failure
      // still reports itself as the assertion that failed rather than as
      // the test clock running out.
      expect: { timeout: 15_000 },
    },
  ],
});
