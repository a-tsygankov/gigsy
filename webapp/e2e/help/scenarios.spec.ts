import { expect, test } from "@playwright/test";
import { executableHelpScenarios, helpScenarios } from "../../src/help/registry.ts";
import { validateHelpRegistry } from "../../src/help/validate.ts";
import { prepareHelpScenario, requireLocalTarget } from "./help-fixtures.ts";
import { runHelpScenario } from "./help-runner.ts";

requireLocalTarget();

test("the registry is structurally valid", () => {
  expect(validateHelpRegistry(helpScenarios)).toEqual([]);
});

for (const scenario of executableHelpScenarios) {
  test(`help: ${scenario.id}`, async ({ page, request, baseURL }) => {
    await prepareHelpScenario(page, request, baseURL!, scenario);
    const trace = await runHelpScenario(page, scenario);

    // A run that did nothing is not a pass. deploy.yml:150 records what
    // happened last time this suite was allowed to report green while
    // skipping most of its work.
    expect(trace.stepsRun).toBeGreaterThan(0);

    // The branch a scenario documents must be the branch it took. An
    // environment change that flips one fails here instead of silently
    // changing what is under test.
    expect(trace.branchesTaken).toEqual(scenario.expectedCiBranches ?? []);
  });
}

for (const scenario of helpScenarios.filter((s) => s.executable === false)) {
  test(`help: ${scenario.id} (described, not executed)`, () => {
    const variants = scenario.variants ?? [];
    expect(variants.length).toBeGreaterThan(0);
    expect(variants.map((v) => v.environment)).toContain("fallback");
    for (const variant of variants) {
      expect(variant.steps.length).toBeGreaterThan(0);
      for (const step of variant.steps) {
        expect(step.description.trim()).not.toBe("");
      }
    }
  });
}
