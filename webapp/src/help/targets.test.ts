/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import {
  HelpTarget,
  dayStart,
  dayToggle,
  resolveTarget,
  targetSelector,
} from "./targets.ts";

/** The markup Toggle actually renders (components/Toggle.tsx): the test
 *  ID sits on a 1x1 sr-only input, and the switch a person can see is a
 *  sibling span inside the wrapping label. */
function renderToggle(testId: string): HTMLElement {
  document.body.innerHTML = `
    <label class="inline-flex h-11 items-center">
      <input type="checkbox" role="switch" class="peer sr-only" data-testid="${testId}" />
      <span aria-hidden="true" class="relative h-6 w-11">
        <span class="absolute left-0.5 top-0.5"></span>
      </span>
    </label>`;
  return document.querySelector("span[aria-hidden='true']")!;
}

describe("resolveTarget", () => {
  it("returns the tagged node for an element target", () => {
    document.body.innerHTML = `<a data-testid="settings-link">Settings</a>`;
    const found = resolveTarget(HelpTarget.SettingsLink);
    expect(found?.tagName).toBe("A");
  });

  it("returns the painted switch, not the sr-only input, for a switch target", () => {
    const paint = renderToggle("toggle-day-0");
    const found = resolveTarget(dayToggle(0));
    expect(found).toBe(paint);
    expect(found?.tagName).toBe("SPAN");
  });

  it("returns null when the target is absent", () => {
    document.body.innerHTML = "";
    expect(resolveTarget(HelpTarget.SettingsLink)).toBeNull();
  });

  it("returns null when a switch target's paint is missing", () => {
    document.body.innerHTML = `<input data-testid="toggle-day-0" />`;
    expect(resolveTarget(dayToggle(0))).toBeNull();
  });
});

describe("targetSelector", () => {
  it("is a plain testid selector for an element target", () => {
    expect(targetSelector(HelpTarget.SettingsLink)).toBe(
      `[data-testid="settings-link"]`,
    );
  });

  // This exact locator is the one e2e/settings.spec.ts already proves
  // correct against the real component. Playwright proves it end to end
  // later; jsdom's :has() support is not something to depend on.
  it("reaches the paint for a switch target", () => {
    expect(targetSelector(dayToggle(3))).toBe(
      `label:has([data-testid="toggle-day-3"]) span[aria-hidden="true"]`,
    );
  });
});

describe("dayStart", () => {
  it("is an element target for the row's start-time select", () => {
    expect(dayStart(2)).toEqual({ id: "start-day-2", kind: "element" });
  });
});

describe("kinds", () => {
  it("records push-toggle as an element despite its name", () => {
    expect(HelpTarget.PushToggle.kind).toBe("element");
  });

  it("records toggle-prefix as a switch despite being a title prefix", () => {
    expect(HelpTarget.TogglePrefix.kind).toBe("switch");
  });
});
