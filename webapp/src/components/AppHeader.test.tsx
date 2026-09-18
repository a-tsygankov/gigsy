/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppHeader } from "./AppHeader.tsx";
import { HelpProvider } from "../help/runtime/HelpProvider.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../lib/app-context.tsx", () => ({
  useData: () => ({}),
  useSyncState: () => null,
  useServices: () => ({ ready: true }),
  useAuthState: () => ({ user: { email: "t@e.com" }, ready: true, signedIn: true }),
  useSyncEngine: () => null,
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

/** The current route, so a test can read where a link took it. */
function WhereAmI() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

async function render(at: string) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[at]}>
        <HelpProvider>
          <AppHeader title="Test" />
          <Routes>
            <Route path="*" element={<WhereAmI />} />
          </Routes>
        </HelpProvider>
      </MemoryRouter>,
    );
  });
  return container;
}

const byId = (el: HTMLElement, id: string) =>
  el.querySelector<HTMLElement>(`[data-testid="${id}"]`);

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

describe("AppHeader controls", () => {
  it("links to the Buy Me a Coffee page in a new, unlinked tab", async () => {
    const el = await render("/");
    const coffee = byId(el, "coffee-link") as HTMLAnchorElement | null;
    expect(coffee?.tagName).toBe("A");
    expect(coffee?.getAttribute("href")).toBe("https://buymeacoffee.com/tsygankov9");
    expect(coffee?.getAttribute("target")).toBe("_blank");
    // `noopener` is what stops the opened page scripting this one; a
    // `_blank` without it is the classic tabnabbing hole.
    expect(coffee?.getAttribute("rel")).toBe("noopener");
    expect(coffee?.getAttribute("aria-label")).toBe("Buy me a coffee");
  });

  it("orders the controls coffee, help, settings", async () => {
    const el = await render("/");
    const ids = [...el.querySelectorAll("header [data-testid]")].map((n) =>
      n.getAttribute("data-testid"),
    );
    expect(ids).toEqual(["coffee-link", "help-link", "settings-link"]);
  });

  it("gives all three the same tap target and the same ringed glyph", async () => {
    const el = await render("/");
    const controls = ["coffee-link", "help-link", "settings-link"].map((id) => byId(el, id)!);
    const first = controls[0]!;
    for (const control of controls.slice(1)) {
      expect(control.className).toBe(first.className);
      expect(control.firstElementChild?.className).toBe(first.firstElementChild?.className);
    }
    // 44px tall: the design system's tap minimum, on every one of them.
    expect(first.className).toContain("h-11");
    expect(first.className).toContain("min-w-11");
  });

  it("keeps Settings named Settings although it is a gear now", async () => {
    // The tour's "Open Settings" step and settings.spec.ts find the
    // control by id and by accessible name, never by the word painted
    // in it — so the word may go, the name may not.
    const el = await render("/");
    const settings = byId(el, "settings-link");
    expect(settings?.getAttribute("aria-label")).toBe("Settings");
    expect(settings?.textContent).not.toContain("Settings");
  });

  it("opens the settings screen from the gear", async () => {
    const el = await render("/gigs");
    await act(async () => {
      byId(el, "settings-link")!.click();
    });
    expect(byId(el, "where")?.textContent).toBe("/settings");
  });

  it("hides the gear on the settings screen, as the text link was", async () => {
    const el = await render("/settings");
    expect(byId(el, "settings-link")).toBeNull();
    // The other two are not about the current screen, so they stay.
    expect(byId(el, "coffee-link")).not.toBeNull();
    expect(byId(el, "help-link")).not.toBeNull();
  });

  it("marks the glyphs as decoration, so the name is what is announced", async () => {
    const el = await render("/");
    for (const id of ["coffee-link", "help-link", "settings-link"]) {
      expect(byId(el, id)?.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
    }
  });
});
