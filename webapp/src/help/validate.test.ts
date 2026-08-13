import { describe, expect, it } from "vitest";
import { HelpTarget } from "./targets.ts";
import { validateHelpRegistry } from "./validate.ts";
import type { HelpScenario } from "./types.ts";

const ok: HelpScenario = {
  id: "ok",
  title: "Fine",
  category: "settings",
  steps: [
    {
      action: "highlight",
      target: HelpTarget.SettingsNotifications,
      description: "Here it is.",
    },
  ],
};

const messages = (scenarios: HelpScenario[]): string[] =>
  validateHelpRegistry(scenarios).map((p) => p.message);

describe("validateHelpRegistry", () => {
  it("passes a well-formed scenario", () => {
    expect(validateHelpRegistry([ok])).toEqual([]);
  });

  it("catches a duplicate scenario id", () => {
    expect(messages([ok, { ...ok }])).toContain("duplicate scenario id");
  });

  it("catches a scenario with nothing in it", () => {
    expect(messages([{ ...ok, steps: [] }])).toContain(
      "scenario has neither steps nor variants",
    );
  });

  it("catches a scenario with both steps and variants", () => {
    const scenario: HelpScenario = {
      ...ok,
      executable: false,
      variants: [
        {
          environment: "fallback",
          label: "Any browser",
          steps: [
            { action: "external", externalType: "os-ui", description: "Tap Share." },
          ],
        },
      ],
    };
    expect(messages([scenario])).toContain(
      "scenario has both steps and variants",
    );
  });

  it("catches a branch step with no branches", () => {
    const scenario: HelpScenario = {
      ...ok,
      steps: [{ action: "branch", branches: [] }],
    };
    expect(messages([scenario])).toContain("branch step has no branches");
  });

  it("catches a branch with no steps", () => {
    const scenario: HelpScenario = {
      ...ok,
      steps: [
        {
          action: "branch",
          branches: [
            {
              id: "empty",
              when: { type: "target-visible", target: HelpTarget.PushToggle },
              steps: [],
            },
          ],
        },
      ],
    };
    expect(messages([scenario])).toContain(`branch "empty" has no steps`);
  });

  it("catches a variant with no steps", () => {
    const scenario: HelpScenario = {
      ...ok,
      executable: false,
      steps: [],
      variants: [{ environment: "fallback", label: "Any browser", steps: [] }],
    };
    expect(messages([scenario])).toContain(`variant "fallback" has no steps`);
  });

  it("catches a non-executable scenario with an executable step", () => {
    const scenario: HelpScenario = { ...ok, executable: false };
    expect(messages([scenario])).toContain(
      "scenario is marked non-executable but contains executable steps",
    );
  });

  it("catches a duplicate branch id", () => {
    const scenario: HelpScenario = {
      ...ok,
      steps: [
        {
          action: "branch",
          branches: [
            {
              id: "same",
              when: { type: "target-visible", target: HelpTarget.PushToggle },
              steps: [ok.steps[0]!],
            },
            {
              id: "same",
              when: { type: "target-missing", target: HelpTarget.PushToggle },
              steps: [ok.steps[0]!],
            },
          ],
        },
      ],
    };
    expect(messages([scenario])).toContain(`duplicate branch id "same"`);
  });

  it("catches a branch nested inside a branch", () => {
    const scenario: HelpScenario = {
      ...ok,
      steps: [
        {
          action: "branch",
          branches: [
            {
              id: "outer",
              when: { type: "target-visible", target: HelpTarget.PushToggle },
              steps: [{ action: "branch", branches: [] }],
            },
          ],
        },
      ],
    };
    expect(messages([scenario])).toContain(
      `branch "outer" nests another branch step`,
    );
  });

  it("catches an external step with no description", () => {
    const scenario: HelpScenario = {
      ...ok,
      executable: false,
      steps: [{ action: "external", externalType: "os-ui", description: "  " }],
    };
    expect(messages([scenario])).toContain(
      "external step has an empty description",
    );
  });

  it("catches expectedCiBranches naming a branch that does not exist", () => {
    expect(messages([{ ...ok, expectedCiBranches: ["ghost"] }])).toContain(
      `expectedCiBranches names "ghost", which is not a branch in this scenario`,
    );
  });

  it("catches an executable scenario whose every step is external", () => {
    const scenario: HelpScenario = {
      ...ok,
      steps: [
        { action: "external", externalType: "os-ui", description: "Tap Share." },
      ],
    };
    expect(messages([scenario])).toContain(
      "scenario is executable but every step is external",
    );
  });

  it("catches variants on an executable scenario", () => {
    const scenario: HelpScenario = {
      ...ok,
      variants: [
        {
          environment: "fallback",
          label: "Any browser",
          steps: [
            { action: "external", externalType: "browser-ui", description: "x" },
          ],
        },
      ],
    };
    expect(messages([scenario])).toContain(
      "variants are only supported on non-executable scenarios",
    );
  });

  it("catches duplicate variant environments and a missing fallback", () => {
    const variant = {
      environment: "ios-safari" as const,
      label: "iPhone",
      steps: [
        {
          action: "external" as const,
          externalType: "os-ui" as const,
          description: "Tap Share.",
        },
      ],
    };
    const scenario: HelpScenario = {
      ...ok,
      executable: false,
      steps: [],
      variants: [variant, { ...variant, label: "iPhone again" }],
    };
    const found = messages([scenario]);
    expect(found).toContain(`duplicate variant environment "ios-safari"`);
    expect(found).toContain("no fallback variant");
  });
});
