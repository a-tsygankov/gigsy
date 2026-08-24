/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { Segmented, type SegmentedOption } from "./Segmented.tsx";

// Same setup as JobCard.test.tsx: react-dom's `act` warns without this,
// because nothing here is React Testing Library.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DEFAULT_OPTIONS: readonly SegmentedOption[] = [
  { to: "/payments", label: "Payments" },
  { to: "/expenses", label: "Expenses" },
];

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function render(path: string, options: readonly SegmentedOption[] = DEFAULT_OPTIONS) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <MemoryRouter initialEntries={[path]}>
        <Segmented testId="money-segment" label="Money" options={options} />
      </MemoryRouter>,
    );
  });
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

describe("Segmented", () => {
  it("renders one link per option", () => {
    const el = render("/payments");
    const links = el.querySelectorAll("a");
    expect([...links].map((a) => a.textContent)).toEqual(["Payments", "Expenses"]);
  });

  it("marks the option matching the current route as current", () => {
    const el = render("/expenses");
    const current = el.querySelector('a[aria-current="page"]');
    expect(current?.textContent).toBe("Expenses");
  });

  it("marks only one option at a time", () => {
    const el = render("/payments");
    expect(el.querySelectorAll('a[aria-current="page"]')).toHaveLength(1);
  });

  // The two fixture routes above (/payments, /expenses) share no path
  // prefix, so none of the tests above can tell whether `end` is set on
  // the underlying NavLink. Use a pair where one route prefixes the
  // other to close that gap: without `end`, "/money" would incorrectly
  // read as current while sitting on "/money/payments".
  it("does not mark a route current just because it prefixes the current path", () => {
    const el = render("/money/payments", [
      { to: "/money", label: "Money" },
      { to: "/money/payments", label: "Payments" },
    ]);
    const current = el.querySelectorAll('a[aria-current="page"]');
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent).toBe("Payments");
  });

  it("carries the testId through to the rendered element, for e2e's getByTestId hook", () => {
    const el = render("/payments");
    expect(el.querySelector('[data-testid="money-segment"]')).not.toBeNull();
  });
});
