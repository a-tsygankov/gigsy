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

    /** Per-step rules, applied identically at the top level and inside
     *  a branch. `where` is the only difference, and it is only there
     *  so a message says which branch to look in. */
    const checkStep = (step: HelpStep, where: string): void => {
      const inBranch = where !== "";

      if (step.action === "external" && step.description.trim() === "") {
        report(
          inBranch
            ? `${where} has an external step with an empty description`
            : "external step has an empty description",
        );
      }

      if (step.action !== "navigate") return;

      if (!executable) report("non-executable scenario has a navigate step");

      const id = step.target.id;
      if (step.route.trim() === "") {
        report(
          inBranch
            ? `${where} has a navigate step for target "${id}" with no route`
            : `navigate step for target "${id}" has no route`,
        );
      } else if (!step.route.startsWith("/")) {
        const tail = `route "${step.route}", which must start with "/"`;
        report(
          inBranch
            ? `${where} has a navigate step for target "${id}" with ${tail}`
            : `navigate step for target "${id}" has ${tail}`,
        );
      }
    };

    /** A terminal step with steps written after it in the same list
     *  silently drops them — the class of quiet wrongness this file
     *  exists to make loud. A terminal step in the LAST position of a
     *  scenario's own steps is a harmless no-op and is not reported:
     *  that would be the validator arguing about redundancy rather than
     *  correctness. */
    const checkTerminalPlacement = (list: HelpStep[], branchId?: string): void => {
      list.forEach((step, index) => {
        if (step.action === "branch" || step.end !== true) return;
        if (index === list.length - 1) return;
        report(
          branchId === undefined
            ? "a step marked end is not the last of the scenario's own steps"
            : `branch "${branchId}" has a step marked end that is not its last`,
        );
      });
    };

    checkTerminalPlacement(scenario.steps);

    for (const step of scenario.steps) {
      checkStep(step, "");
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
        checkTerminalPlacement(branch.steps, branch.id);
        for (const inner of branch.steps) {
          checkStep(inner, `branch "${branch.id}"`);
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
      // A non-executable scenario has no tour to run, and the only thing
      // that renders one is HelpMenu's VariantPicker — which reads
      // `variants` and ignores `scenario.steps` entirely. So a scenario
      // that is non-executable, carries steps, and declares no variants
      // renders as an empty <Select> with no instructions under it: a
      // dead end, exactly like the one "no fallback variant" exists to
      // prevent. Guarded on `steps.length > 0` (and unreachable when
      // variants exist) so it never doubles up with "scenario has
      // neither steps nor variants", which already covers the empty case.
      if (!executable && variants.length === 0) {
        report(
          "non-executable scenario has steps but no variants — nothing renders them",
        );
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
          checkStep(step, `variant "${variant.environment}"`);
        }
      }
      // A wrong user-agent guess must never leave someone with nothing.
      if (!seenEnvironments.has("fallback")) report("no fallback variant");
    }
  }

  return problems;
}
