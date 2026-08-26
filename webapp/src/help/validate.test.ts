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

  it("catches a non-executable scenario with steps but no variants", () => {
    // Well-formed in every other respect: non-executable and every step
    // external, so no other rule fires. VariantPicker still reads only
    // `variants`, so this renders as an empty picker with no
    // instructions — the dead end this rule exists to catch.
    const scenario: HelpScenario = {
      ...ok,
      executable: false,
      steps: [
        { action: "external", externalType: "os-ui", description: "Tap Share." },
      ],
    };
    expect(messages([scenario])).toEqual([
      "non-executable scenario has steps but no variants — nothing renders them",
    ]);
  });

  it("does not report the missing variants twice for an empty scenario", () => {
    // "scenario has neither steps nor variants" already covers this;
    // the new rule must not pile a second, more confusing message on it.
    expect(messages([{ ...ok, executable: false, steps: [] }])).toEqual([
      "scenario has neither steps nor variants",
    ]);
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

  it("catches a navigate step with an empty route", () => {
    const scenario: HelpScenario = {
      ...ok,
      steps: [
        {
          action: "navigate",
          target: HelpTarget.GigList,
          route: "",
          description: "Tap the one you want.",
        },
      ],
    };
    expect(messages([scenario])).toContain(
      'navigate step for target "gig-list" has no route',
    );
  });

  it("catches a navigate route that is not a path", () => {
    const scenario: HelpScenario = {
      ...ok,
      steps: [
        {
          action: "navigate",
          target: HelpTarget.GigList,
          route: "gigs/:id",
          description: "Tap the one you want.",
        },
      ],
    };
    expect(messages([scenario])).toContain(
      'navigate step for target "gig-list" has route "gigs/:id", which must start with "/"',
    );
  });

  it("catches a navigate step inside a branch, too", () => {
    const scenario: HelpScenario = {
      ...ok,
      steps: [
        {
          action: "branch",
          branches: [
            {
              id: "only",
              when: { type: "target-visible", target: HelpTarget.GigList },
              steps: [
                {
                  action: "navigate",
                  target: HelpTarget.GigList,
                  route: "",
                  description: "Tap the one you want.",
                },
              ],
            },
          ],
        },
      ],
    };
    expect(messages([scenario])).toContain(
      'branch "only" has a navigate step for target "gig-list" with no route',
    );
  });

  it("catches a bad navigate route inside a branch", () => {
    const scenario: HelpScenario = {
      ...ok,
      steps: [
        {
          action: "branch",
          branches: [
            {
              id: "only",
              when: { type: "target-visible", target: HelpTarget.GigList },
              steps: [
                {
                  action: "navigate",
                  target: HelpTarget.GigList,
                  route: "gigs/:id",
                  description: "Tap the one you want.",
                },
              ],
            },
          ],
        },
      ],
    };
    expect(messages([scenario])).toContain(
      'branch "only" has a navigate step for target "gig-list" with route "gigs/:id", which must start with "/"',
    );
  });

  it("catches a navigate step in a non-executable scenario", () => {
    // A non-executable scenario is browser and OS chrome, where there
    // is no route to reach and nothing to tap.
    const scenario: HelpScenario = {
      ...ok,
      executable: false,
      steps: [
        {
          action: "navigate",
          target: HelpTarget.GigList,
          route: "/gigs/:id",
          description: "Tap the one you want.",
        },
      ],
    };
    expect(messages([scenario])).toContain(
      "non-executable scenario has a navigate step",
    );
  });

  it("catches a terminal step that is not last in the scenario", () => {
    const scenario: HelpScenario = {
      ...ok,
      steps: [
        {
          action: "highlight",
          target: HelpTarget.SettingsNotifications,
          description: "Stops here.",
          end: true,
        },
        {
          action: "highlight",
          target: HelpTarget.SettingsCapture,
          description: "Unreachable.",
        },
      ],
    };
    expect(messages([scenario])).toContain(
      "a step marked end is not the last of the scenario's own steps",
    );
  });

  it("catches a terminal step that is not last in its branch", () => {
    const scenario: HelpScenario = {
      ...ok,
      steps: [
        {
          action: "branch",
          branches: [
            {
              id: "only",
              when: { type: "target-visible", target: HelpTarget.GigList },
              steps: [
                {
                  action: "highlight",
                  target: HelpTarget.SettingsNotifications,
                  description: "Stops here.",
                  end: true,
                },
                {
                  action: "highlight",
                  target: HelpTarget.SettingsCapture,
                  description: "Unreachable.",
                },
              ],
            },
          ],
        },
      ],
    };
    expect(messages([scenario])).toContain(
      'branch "only" has a step marked end that is not its last',
    );
  });

  it("allows a terminal step in the last position of a branch", () => {
    // The shape record-work depends on: a dead-end alternative ends,
    // and the steps written after the branch belong to the one that
    // did not. A second alternative that does NOT end is essential here
    // — if this branch's only alternative ended, every path through it
    // would be a dead end, and "every alternative of a branch step ends"
    // would (correctly) flag the step below as unreachable.
    const scenario: HelpScenario = {
      ...ok,
      steps: [
        {
          action: "branch",
          branches: [
            {
              id: "dead-end",
              when: { type: "target-visible", target: HelpTarget.GigList },
              steps: [
                {
                  action: "highlight",
                  target: HelpTarget.SettingsNotifications,
                  description: "Stops here.",
                  end: true,
                },
              ],
            },
            {
              id: "continues",
              when: { type: "target-missing", target: HelpTarget.GigList },
              steps: [
                {
                  action: "highlight",
                  target: HelpTarget.SettingsNotifications,
                  description: "Keeps going.",
                },
              ],
            },
          ],
        },
        {
          action: "highlight",
          target: HelpTarget.SettingsCapture,
          description: "Reached only by an alternative that did not end.",
        },
      ],
    };
    expect(validateHelpRegistry([scenario])).toEqual([]);
  });

  it("allows a terminal step in the last position of the scenario", () => {
    const scenario: HelpScenario = {
      ...ok,
      steps: [
        {
          action: "highlight",
          target: HelpTarget.SettingsNotifications,
          description: "First stop.",
        },
        {
          action: "highlight",
          target: HelpTarget.SettingsCapture,
          description: "Stops here.",
          end: true,
        },
      ],
    };
    expect(validateHelpRegistry([scenario])).toEqual([]);
  });

  it("catches steps written after a branch whose every alternative ends", () => {
    // The same "silently drops what follows" wrongness the plain `end`
    // rule catches, one level up: if EVERY alternative of a branch ends,
    // the branch itself is terminal on every path, so anything written
    // after it is dead on arrival — even though no individual step here
    // is out of place within its own list.
    const scenario: HelpScenario = {
      ...ok,
      steps: [
        {
          action: "branch",
          branches: [
            {
              id: "a",
              when: { type: "target-visible", target: HelpTarget.GigList },
              steps: [
                {
                  action: "highlight",
                  target: HelpTarget.SettingsNotifications,
                  description: "Stops here.",
                  end: true,
                },
              ],
            },
            {
              id: "b",
              when: { type: "target-missing", target: HelpTarget.GigList },
              steps: [
                {
                  action: "highlight",
                  target: HelpTarget.SettingsCapture,
                  description: "Also stops here.",
                  end: true,
                },
              ],
            },
          ],
        },
        {
          action: "highlight",
          target: HelpTarget.PushToggle,
          description: "Unreachable on every path.",
        },
      ],
    };
    expect(messages([scenario])).toContain(
      "every alternative of a branch step ends, but steps are written after it",
    );
  });

  it("allows a branch whose every alternative ends, when the branch is the scenario's last step", () => {
    const scenario: HelpScenario = {
      ...ok,
      steps: [
        {
          action: "branch",
          branches: [
            {
              id: "a",
              when: { type: "target-visible", target: HelpTarget.GigList },
              steps: [
                {
                  action: "highlight",
                  target: HelpTarget.SettingsNotifications,
                  description: "Stops here.",
                  end: true,
                },
              ],
            },
            {
              id: "b",
              when: { type: "target-missing", target: HelpTarget.GigList },
              steps: [
                {
                  action: "highlight",
                  target: HelpTarget.SettingsCapture,
                  description: "Also stops here.",
                  end: true,
                },
              ],
            },
          ],
        },
      ],
    };
    expect(validateHelpRegistry([scenario])).toEqual([]);
  });

  it("allows a well-formed navigate step, and never calls it external", () => {
    // Pins the positive case for all three navigate rules at once: a
    // route rule inverted to fire on good input and stay silent on bad
    // would still pass every `toContain` assertion above it. Also covers
    // `everyStepExternal` — "executable but every step is external" — a
    // navigate step is something a person does, so it must never satisfy
    // that.
    const scenario: HelpScenario = {
      ...ok,
      steps: [
        {
          action: "navigate",
          target: HelpTarget.GigList,
          route: "/gigs/:id",
          description: "Tap the one you want.",
        },
      ],
    };
    expect(validateHelpRegistry([scenario])).toEqual([]);
  });

  it("catches a variant step marked end, which does nothing outside a tour", () => {
    // A variant renders as prose through HelpMenu's VariantPicker —
    // there is no tour, so nothing ever reads `end` here.
    const scenario: HelpScenario = {
      ...ok,
      executable: false,
      steps: [],
      variants: [
        {
          environment: "fallback",
          label: "Any browser",
          steps: [
            {
              action: "external",
              externalType: "os-ui",
              description: "Tap Share.",
              end: true,
            },
          ],
        },
      ],
    };
    expect(messages([scenario])).toContain(
      'variant "fallback" has a step marked end, which does nothing outside a tour',
    );
  });
});
