import { expect, test } from "@playwright/test";
import { configureWorkingHours } from "../../src/help/scenarios/working-hours.ts";
import { prepareHelpScenario, requireLocalTarget } from "./help-fixtures.ts";
import { runHelpScenario } from "./help-runner.ts";

requireLocalTarget();

/**
 * A screen that is slow to arrive is still a screen the help documents.
 *
 * `configure-working-hours` went flaky on CI: `AvailabilitySection`
 * renders nothing until `GET /api/settings` resolves, and the runner's
 * `highlight` step was waiting on Playwright's default 5s `expect`
 * timeout. On a cold preview — worker cold start plus D1 — that budget
 * ran out, the first attempt failed with "element(s) not found", the
 * retry passed, and the job reported "1 flaky" and went green.
 *
 * The runner already knew 5s was too short: branch resolution has its
 * own explicit 10s budget. Plain steps had simply never been given the
 * same treatment.
 *
 * This test makes the slowness deterministic rather than waiting for a
 * cold runner to produce it: the settings response is held past the old
 * default, so the scenario cannot pass on a runner that still uses it.
 * It fails with "element(s) not found" against the pre-fix runner.
 */
const SETTINGS_DELAY_MS = 6_500;

test("a documented target still resolves when its screen is slow to load", async ({
  page,
  request,
  baseURL,
}) => {
  // Only the read is delayed. `prepareHelpScenario` PATCHes settings to
  // reset the working week, and holding that back would slow the setup
  // without testing anything the scenario cares about.
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, SETTINGS_DELAY_MS));
    await route.fallback();
  });

  await prepareHelpScenario(page, request, baseURL!, configureWorkingHours);
  const trace = await runHelpScenario(page, configureWorkingHours);

  expect(trace.stepsRun).toBeGreaterThan(0);
  expect(trace.branchesTaken).toEqual(configureWorkingHours.expectedCiBranches ?? []);
});
