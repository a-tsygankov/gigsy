import { describe, expect, it } from "vitest";
import {
  executableHelpScenarios,
  getHelpScenario,
  helpScenarios,
} from "./registry.ts";
import { validateHelpRegistry } from "./validate.ts";

describe("the help registry", () => {
  it("is structurally valid", () => {
    expect(validateHelpRegistry(helpScenarios)).toEqual([]);
  });

  it("finds a scenario by id", () => {
    expect(getHelpScenario("open-settings")?.title).toBe("Open Settings");
  });

  it("returns undefined for an unknown id", () => {
    expect(getHelpScenario("nope")).toBeUndefined();
  });

  it("excludes install-gigsy — the one scenario that opts out of execution — from executableHelpScenarios", () => {
    // install-gigsy lives entirely in browser and OS chrome (see
    // scenarios/install-app.ts), so it must be discoverable in the full
    // registry but never handed to the Playwright runner. Asserting both
    // sides, plus the count actually differing, is what makes this fail
    // if `executableHelpScenarios`'s `.filter(...)` in registry.ts were
    // ever deleted — with the filter removed the two arrays become the
    // same array, "install-gigsy" would appear in both, and the count
    // difference below would be `0` instead of `1`.
    expect(helpScenarios.map((s) => s.id)).toContain("install-gigsy");
    expect(executableHelpScenarios.map((s) => s.id)).not.toContain(
      "install-gigsy",
    );
    expect(helpScenarios.length - executableHelpScenarios.length).toBe(1);
  });

  // Opening help from Settings and being told to tap a link that
  // AppHeader hides on that very screen is the trap startRoute exists
  // to avoid (AppHeader.tsx:43).
  it("starts the settings-link scenario somewhere that renders it", () => {
    expect(getHelpScenario("open-settings")?.startRoute).toBe("/");
  });
});
