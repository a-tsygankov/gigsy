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

  it("lists every scenario as executable until one opts out", () => {
    expect(executableHelpScenarios.length).toBe(helpScenarios.length);
  });

  // Opening help from Settings and being told to tap a link that
  // AppHeader hides on that very screen is the trap startRoute exists
  // to avoid (AppHeader.tsx:43).
  it("starts the settings-link scenario somewhere that renders it", () => {
    expect(getHelpScenario("open-settings")?.startRoute).toBe("/");
  });
});
