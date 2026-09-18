/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExtraDatesField, type ExtraDatesFieldProps } from "./ExtraDatesField.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The real DateTimeField is a popover with a lazily imported calendar,
 * and none of that is what this component is about. A plain input that
 * carries the same `testId`, `label` and `data-value` contract stands in
 * for it, so a row's presence and its value are readable straight off
 * the DOM. The mocked path is the file, not the barrel: the barrel
 * re-exports it, so both resolve to this shim.
 */
vi.mock("./DateTimeField.tsx", () => ({
  DateTimeField: ({
    testId,
    label,
    value,
    onChange,
  }: {
    testId?: string;
    label?: string;
    value: string;
    onChange: (v: string) => void;
  }) => (
    <input
      data-testid={testId}
      data-value={value}
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function render(props: ExtraDatesFieldProps): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<ExtraDatesField {...props} />));
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

const byId = (id: string) => container!.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = (el: HTMLElement | null) =>
  act(() => {
    el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });

describe("ExtraDatesField", () => {
  it("renders one row per value, each named by its position", () => {
    render({ values: ["2026-09-14T09:00", ""], onChange: () => {}, testId: "x" });
    expect(byId("x-0")?.dataset["value"]).toBe("2026-09-14T09:00");
    expect(byId("x-1")?.dataset["value"]).toBe("");
    expect(byId("x-2")).toBeNull();
    expect(byId("x-0")?.getAttribute("aria-label")).toBe("Also on 1");
    expect(byId("x-1")?.getAttribute("aria-label")).toBe("Also on 2");
    expect(byId("x-remove-0")).not.toBeNull();
    expect(byId("x-remove-1")).not.toBeNull();
  });

  it("says what the rows are for", () => {
    const el = render({ values: [], onChange: () => {}, testId: "x" });
    expect(el.textContent).toContain("Also on");
    expect(el.textContent).toContain("one gig is created per date");
  });

  it("appends a blank row on add", () => {
    // State lives with the caller: the component reports the new list
    // and renders whatever it is handed back.
    const onChange = vi.fn();
    render({ values: ["2026-09-14T09:00"], onChange, testId: "x" });
    click(byId("x-add"));
    expect(onChange).toHaveBeenCalledWith(["2026-09-14T09:00", ""]);
  });

  it("removes exactly the row whose button was pressed", () => {
    const onChange = vi.fn();
    render({
      values: ["2026-09-14T09:00", "2026-09-15T09:00", "2026-09-16T09:00"],
      onChange,
      testId: "x",
    });
    click(byId("x-remove-1"));
    expect(onChange).toHaveBeenCalledWith(["2026-09-14T09:00", "2026-09-16T09:00"]);
  });

  it("reports a changed row in place, leaving the others alone", () => {
    const onChange = vi.fn();
    render({ values: ["", "2026-09-15T09:00"], onChange, testId: "x" });
    const row = byId("x-0") as HTMLInputElement;
    // React tracks a text input off the native "input" event, through
    // the prototype's value setter (see DateTimeField.test.tsx).
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(row, "2026-09-14T10:00");
    act(() => {
      row.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith(["2026-09-14T10:00", "2026-09-15T09:00"]);
  });

  it("uses the label it is given for the heading and the rows", () => {
    const el = render({ values: [""], onChange: () => {}, testId: "x", label: "Repeats on" });
    expect(el.textContent).toContain("Repeats on");
    expect(byId("x-0")?.getAttribute("aria-label")).toBe("Repeats on 1");
  });
});
