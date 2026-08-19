/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DateTimeField, type DateTimeFieldProps } from "./DateTimeField.tsx";

// Same setup as HelpProvider.test.tsx: react-dom's `act` warns without
// this, because nothing here is React Testing Library.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function render(props: DateTimeFieldProps): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<DateTimeField {...props} />));
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

describe("DateTimeField", () => {
  it("renders a time input, not a select", () => {
    const el = render({ testId: "f", value: "2026-09-12T14:18", onChange: () => {} });
    const time = el.querySelector<HTMLInputElement>("[data-testid='f-time']")!;
    expect(time.tagName).toBe("INPUT");
    expect(time.type).toBe("time");
    expect(time.value).toBe("14:18");
  });

  it("emits the joined value when the time changes to an off-quarter minute", () => {
    const onChange = vi.fn();
    const el = render({ testId: "f", value: "2026-09-12T09:00", onChange });
    const time = el.querySelector<HTMLInputElement>("[data-testid='f-time']")!;
    setValue(time, "14:07");
    expect(onChange).toHaveBeenCalledWith("2026-09-12T14:07");
  });

  it("clears the whole value when the date is cleared", () => {
    const onChange = vi.fn();
    const el = render({ testId: "f", value: "2026-09-12T14:18", onChange });
    const date = el.querySelector<HTMLInputElement>("[data-testid='f-date']")!;
    setValue(date, "");
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("fills 09:00 when a date is picked before a time", () => {
    const onChange = vi.fn();
    const el = render({ testId: "f", value: "", onChange });
    const date = el.querySelector<HTMLInputElement>("[data-testid='f-date']")!;
    setValue(date, "2026-09-12");
    expect(onChange).toHaveBeenCalledWith("2026-09-12T09:00");
  });

  it("disables the time until there is a date to attach it to", () => {
    const el = render({ testId: "f", value: "", onChange: () => {} });
    const time = el.querySelector<HTMLInputElement>("[data-testid='f-time']")!;
    expect(time.disabled).toBe(true);
  });
});
