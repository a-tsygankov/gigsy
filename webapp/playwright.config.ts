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
    },
  ],
});
