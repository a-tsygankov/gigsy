/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DurationField, type DurationFieldProps } from "./DurationField.tsx";

// Same setup as HelpProvider.test.tsx: react-dom's `act` warns without
// this, because nothing here is React Testing Library.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function render(props: DurationFieldProps): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<DurationField {...props} />));
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

/**
 * React tracks controlled inputs off the native "input" event, not
 * "change" — dispatching "change" alone leaves onChange unfired in a
 * plain jsdom render with no React Testing Library in front of it.
 */
function setValue(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(el, value);
  act(() => {
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("DurationField", () => {
  it("splits stored minutes into hours and minutes", () => {
    const el = render({ testId: "d", value: "200", onChange: () => {} });
    const hours = el.querySelector<HTMLInputElement>("[data-testid='d-hours']")!;
    const minutes = el.querySelector<HTMLInputElement>("[data-testid='d-minutes']")!;
    expect(hours.value).toBe("3");
    expect(minutes.value).toBe("20");
  });

  it("shows both halves empty when unset", () => {
    const el = render({ testId: "d", value: "", onChange: () => {} });
    const hours = el.querySelector<HTMLInputElement>("[data-testid='d-hours']")!;
    const minutes = el.querySelector<HTMLInputElement>("[data-testid='d-minutes']")!;
    expect(hours.value).toBe("");
    expect(minutes.value).toBe("");
  });

  it("emits total minutes when the hours change", () => {
    const onChange = vi.fn();
    const el = render({ testId: "d", value: "20", onChange });
    const hours = el.querySelector<HTMLInputElement>("[data-testid='d-hours']")!;
    setValue(hours, "3");
    expect(onChange).toHaveBeenCalledWith("200");
  });

  it("emits empty when both halves are cleared", () => {
    const onChange = vi.fn();
    const el = render({ testId: "d", value: "60", onChange });
    const hours = el.querySelector<HTMLInputElement>("[data-testid='d-hours']")!;
    setValue(hours, "");
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("treats a lone minutes entry as a duration", () => {
    const onChange = vi.fn();
    const el = render({ testId: "d", value: "", onChange });
    const minutes = el.querySelector<HTMLInputElement>("[data-testid='d-minutes']")!;
    setValue(minutes, "45");
    expect(onChange).toHaveBeenCalledWith("45");
  });
});
