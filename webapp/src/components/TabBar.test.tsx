/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { TabBar } from "./TabBar.tsx";

// Same setup as Segmented.test.tsx: react-dom's `act` warns without
// this, because nothing here is React Testing Library.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function render(path: string) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <MemoryRouter initialEntries={[path]}>
        <TabBar />
      </MemoryRouter>,
    );
  });
  return container;
}

function currentLabel(el: HTMLElement): string | null {
  return el.querySelector('a[aria-current="page"]')?.textContent ?? null;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

describe("TabBar", () => {
  // The regression this file exists to catch: `/expenses` is not the
  // Money tab's own `to`, only a path it also owns. A plain `NavLink`
  // has no way to say that, which is exactly how the rename briefly
  // shipped with the Money tab going dark on every expense screen.
  it("lights Money on /payments, /expenses, and /expenses/new", () => {
    expect(currentLabel(render("/payments"))).toBe("Money");
    expect(currentLabel(render("/expenses"))).toBe("Money");
    expect(currentLabel(render("/expenses/new"))).toBe("Money");
  });

  it("lights Gigs on /gigs and a gig's own page", () => {
    expect(currentLabel(render("/gigs"))).toBe("Gigs");
    expect(currentLabel(render("/gigs/abc"))).toBe("Gigs");
  });

  // The `exact` case: Home owns only "/" itself, unlike every other tab
  // whose ownership extends to sub-paths.
  it("lights Home on / but not on /gigs", () => {
    expect(currentLabel(render("/"))).toBe("Home");
    expect(currentLabel(render("/gigs"))).not.toBe("Home");
  });

  it("marks exactly one tab current at a time", () => {
    const el = render("/expenses/new");
    expect(el.querySelectorAll('a[aria-current="page"]')).toHaveLength(1);
  });
});
