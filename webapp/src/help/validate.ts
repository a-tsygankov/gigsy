/**
 * Structural checks that need no browser. Whether a target still exists
 * in the DOM is not a static question — that is what the Playwright
 * suite is for. An *unknown* target cannot happen at all: steps hold
 * HelpTarget objects, so TypeScript rejects one that does not exist.
 */
import type { HelpScenario, HelpStep } from "./types.ts";

export interface HelpProblem {
  scenarioId: string;
  message: string;
}

function everyStepExternal(steps: HelpStep[]): boolean {
  return steps.every((step) =>
    step.action === "external"
      ? true
      : step.action === "branch"
        ? step.branches.every((b) => everyStepExternal(b.steps))
        : false,
  );
}

export function validateHelpRegistry(scenarios: HelpScenario[]): HelpProblem[] {
  const problems: HelpProblem[] = [];
  const seenScenarios = new Set<string>();

  for (const scenario of scenarios) {
    const report = (message: string): void => {
      problems.push({ scenarioId: scenario.id, message });
    };

    if (seenScenarios.has(scenario.id)) report("duplicate scenario id");
    seenScenarios.add(scenario.id);

    const variants = scenario.variants ?? [];
    const executable = scenario.executable !== false;

    if (scenario.steps.length === 0 && variants.length === 0) {
      report("scenario has neither steps nor variants");
    }
    if (scenario.steps.length > 0 && variants.length > 0) {
      // The model treats these as alternatives: installation carries
      // variants *instead of* steps, and nothing downstream is
      // specified to know which to render if a scenario has both.
      report("scenario has both steps and variants");
    }

    const branchIds = new Set<string>();
    const checkExternal = (step: HelpStep, where: string): void => {
      if (step.action === "external" && step.description.trim() === "") {
        report(
          where === ""
            ? "external step has an empty description"
            : `${where} has an external step with an empty description`,
        );
      }
    };

    for (const step of scenario.steps) {
      checkExternal(step, "");
      if (step.action !== "branch") continue;

      if (step.branches.length === 0) report("branch step has no branches");
      for (const branch of step.branches) {
        if (branchIds.has(branch.id)) {
          report(`duplicate branch id "${branch.id}"`);
        }
        branchIds.add(branch.id);

        if (branch.steps.length === 0) {
          report(`branch "${branch.id}" has no steps`);
        }
        if (branch.steps.some((s) => s.action === "branch")) {
          report(`branch "${branch.id}" nests another branch step`);
        }
        for (const inner of branch.steps) {
          checkExternal(inner, `branch "${branch.id}"`);
        }
      }
    }

    for (const id of scenario.expectedCiBranches ?? []) {
      if (!branchIds.has(id)) {
        report(
          `expectedCiBranches names "${id}", which is not a branch in this scenario`,
        );
      }
    }

    if (scenario.steps.length > 0) {
      const allExternal = everyStepExternal(scenario.steps);
      if (executable && allExternal) {
        report("scenario is executable but every step is external");
      }
      if (!executable && !allExternal) {
        report("scenario is marked non-executable but contains executable steps");
      }
    }

    if (variants.length > 0) {
      if (executable) {
        report("variants are only supported on non-executable scenarios");
      }
      const seenEnvironments = new Set<string>();
      for (const variant of variants) {
        if (seenEnvironments.has(variant.environment)) {
          report(`duplicate variant environment "${variant.environment}"`);
        }
        seenEnvironments.add(variant.environment);
        if (variant.steps.length === 0) {
          report(`variant "${variant.environment}" has no steps`);
        }
        for (const step of variant.steps) {
          checkExternal(step, `variant "${variant.environment}"`);
        }
      }
      // A wrong user-agent guess must never leave someone with nothing.
      if (!seenEnvironments.has("fallback")) report("no fallback variant");
    }
  }

  return problems;
}
