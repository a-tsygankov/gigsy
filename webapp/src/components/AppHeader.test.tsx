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

  /** The ringed mark inside a control: a <span> for the two text glyphs,
   *  the <img> for the coffee (its <picture> wrapper carries no style). */
  const glyphOf = (control: HTMLElement) =>
    control.querySelector<HTMLElement>(":scope > span, :scope > picture > img");

  it("gives all three the same tap target and the same ring", async () => {
    const el = await render("/");
    const controls = ["coffee-link", "help-link", "settings-link"].map((id) => byId(el, id)!);
    const first = controls[0]!;
    const ring = (control: HTMLElement) =>
      // The coffee adds `object-cover` to fill its ring with the disc;
      // everything else about the ring must be identical.
      glyphOf(control)!.className.replace(" object-cover", "");
    for (const control of controls.slice(1)) {
      expect(control.className).toBe(first.className);
      expect(ring(control)).toBe(ring(first));
    }
    // 44px tall — the design system's tap minimum — and 40 wide, with
    // no gap, so the three rings sit 16px apart and read as one set
    // (AppHeader.tsx's HEADER_CONTROL comment has the arithmetic).
    expect(first.className).toContain("h-11");
    expect(first.className).toContain("min-w-10");
    expect(first.parentElement?.className).toContain("gap-0");
  });

  it("draws the coffee as the animated icon, with a still for reduced motion", async () => {
    const el = await render("/");
    const coffee = byId(el, "coffee-link")!;
    const img = coffee.querySelector("picture > img");
    const still = coffee.querySelector("picture > source");
    expect(img?.getAttribute("src")).toMatch(/coffee.*\.gif$/);
    expect(still?.getAttribute("srcset")).toMatch(/coffee-still.*\.png$/);
    expect(still?.getAttribute("media")).toBe("(prefers-reduced-motion: reduce)");
    // Drawn at the ring's size, whatever the file's own pixels.
    expect(img?.getAttribute("width")).toBe("24");
    expect(img?.getAttribute("height")).toBe("24");
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
      expect(glyphOf(byId(el, id)!)?.getAttribute("aria-hidden")).toBe("true");
    }
    // And the image says nothing of its own either.
    expect(byId(el, "coffee-link")?.querySelector("img")?.getAttribute("alt")).toBe("");
  });
});
