/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { HelpTarget } from "../targets.ts";
import type { BranchStep, HighlightStep } from "../types.ts";
import { flatten } from "./TourRenderer.ts";

/** jsdom never computes layout, so every element's rect is zero-sized
 *  by default — `conditionHolds` reads `height > 0` as "visible", so a
 *  target-visible test needs a stubbed rect to ever hold. */
function stubVisible(testId: string): void {
  document.body.innerHTML = `<a data-testid="${testId}">Settings</a>`;
  const el = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  el!.getBoundingClientRect = () =>
    ({
      height: 40,
      width: 40,
      top: 0,
      left: 0,
      right: 40,
      bottom: 40,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
}

describe("flatten", () => {
  it("passes a branch-free step list through unchanged", async () => {
    const steps: HighlightStep[] = [
      { action: "highlight", target: HelpTarget.SettingsLink, description: "a" },
      { action: "highlight", target: HelpTarget.SettingsHelp, description: "b" },
    ];

    await expect(flatten(steps)).resolves.toEqual(steps);
  });

  it("takes the first branch whose target-visible condition holds", async () => {
    stubVisible("settings-link");
    const taken: HighlightStep = {
      action: "highlight",
      target: HelpTarget.SettingsHelp,
      description: "taken",
    };
    const notTaken: HighlightStep = {
      action: "highlight",
      target: HelpTarget.SettingsHelp,
      description: "not-taken",
    };
    const branch: BranchStep = {
      action: "branch",
      branches: [
        {
          id: "visible",
          when: { type: "target-visible", target: HelpTarget.SettingsLink },
          steps: [taken],
        },
        {
          id: "fallback",
          when: { type: "target-missing", target: HelpTarget.SettingsLink },
          steps: [notTaken],
        },
      ],
    };

    await expect(flatten([branch])).resolves.toEqual([taken]);
  });

  it("takes a target-missing branch when the element is absent", async () => {
    document.body.innerHTML = "";
    const taken: HighlightStep = {
      action: "highlight",
      target: HelpTarget.SettingsHelp,
      description: "taken",
    };
    const notTaken: HighlightStep = {
      action: "highlight",
      target: HelpTarget.SettingsHelp,
      description: "not-taken",
    };
    const branch: BranchStep = {
      action: "branch",
      branches: [
        {
          id: "visible",
          when: { type: "target-visible", target: HelpTarget.SettingsLink },
          steps: [notTaken],
        },
        {
          id: "missing",
          when: { type: "target-missing", target: HelpTarget.SettingsLink },
          steps: [taken],
        },
      ],
    };

    await expect(flatten([branch])).resolves.toEqual([taken]);
  });

  it("interleaves resolved branch steps with the plain steps around them", async () => {
    document.body.innerHTML = "";
    const before: HighlightStep = {
      action: "highlight",
      target: HelpTarget.SettingsLink,
      description: "before",
    };
    const taken: HighlightStep = {
      action: "highlight",
      target: HelpTarget.SettingsHelp,
      description: "taken",
    };
    const after: HighlightStep = {
      action: "highlight",
      target: HelpTarget.SettingsNotifications,
      description: "after",
    };
    const branch: BranchStep = {
      action: "branch",
      branches: [
        {
          id: "missing",
          when: { type: "target-missing", target: HelpTarget.SettingsLink },
          steps: [taken],
        },
      ],
    };

    await expect(flatten([before, branch, after])).resolves.toEqual([
      before,
      taken,
      after,
    ]);
  });
});
