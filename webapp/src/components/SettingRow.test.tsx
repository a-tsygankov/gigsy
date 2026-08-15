/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { SettingGroup } from "./SettingRow.tsx";

// Same setup as HelpProvider.test.tsx: react-dom's `act` warns without
// this, because nothing here is React Testing Library.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function render(node: React.ReactNode): HTMLElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(node));
  return container.firstElementChild as HTMLElement;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("SettingGroup", () => {
  it("draws on the card surface by default", () => {
    const el = render(<SettingGroup title="Calendar">rows</SettingGroup>);
    expect(el.className).toContain("bg-white");
    expect(el.className).not.toContain("bg-sky-100");
  });

  /**
   * Help is the one block on the Settings screen that is not a setting.
   * On the card surface it read as a fourteenth one.
   */
  it("draws on the help surface when asked", () => {
    const el = render(
      <SettingGroup title="Help" description="Walkthroughs." tone="help">
        rows
      </SettingGroup>,
    );
    expect(el.className).toContain("bg-sky-100");
    expect(el.className).toContain("border-sky-200");
    expect(el.className).not.toContain("bg-white");
  });

  it("lifts the description off slate-500, which the tint costs contrast", () => {
    const el = render(
      <SettingGroup title="Help" description="Walkthroughs." tone="help">
        rows
      </SettingGroup>,
    );
    const description = el.querySelector("p")!;
    expect(description.className).toContain("text-slate-600");
    expect(description.className).not.toContain("text-slate-500");
  });
});
