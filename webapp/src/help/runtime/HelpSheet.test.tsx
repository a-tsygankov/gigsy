/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HelpProvider } from "./HelpProvider.tsx";
import { HelpSheet } from "./HelpSheet.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The sheet's feedback face reads the data service and the sync state;
// the menu face reads neither. Mocked the way every screen test does
// (Capture.test.tsx), so no real store or engine is built here.
vi.mock("../../lib/app-context.tsx", () => ({
  useData: () => ({ sendFeedback: vi.fn() }),
  useSyncState: () => ({ online: true, pendingCount: 0 }),
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;
const onClose = vi.fn();

/** The sheet mounted directly inside a HelpProvider — the menu needs
 *  `useHelp`, and the provider needs a router. The provider's own
 *  `isOpen` is left false so only this one sheet is in the tree. */
function mount(): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <MemoryRouter initialEntries={["/"]}>
        <HelpProvider>
          <HelpSheet onClose={onClose} />
        </HelpProvider>
      </MemoryRouter>,
    );
  });
  return container;
}

beforeEach(() => {
  vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:x", revokeObjectURL: vi.fn() });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const byId = <T extends HTMLElement>(el: HTMLElement, id: string) =>
  el.querySelector<T>(`[data-testid="${id}"]`);

function click(el: HTMLElement | null): void {
  act(() => {
    el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("HelpSheet", () => {
  it("opens on the menu, with the feedback button beside Close", () => {
    const el = mount();
    expect(el.querySelector("#help-sheet-heading")!.textContent).toBe("Help");
    expect(byId(el, "help-search")).not.toBeNull();
    expect(byId(el, "help-feedback")!.textContent).toBe("Send feedback");
    expect(byId(el, "help-sheet-close")).not.toBeNull();
    expect(byId(el, "feedback-form")).toBeNull();
  });

  it("swaps the menu for the form, renames the heading, and hides its own button", () => {
    const el = mount();
    click(byId(el, "help-feedback"));

    expect(el.querySelector("#help-sheet-heading")!.textContent).toBe("Send feedback");
    expect(byId(el, "feedback-form")).not.toBeNull();
    expect(byId(el, "feedback-message")).not.toBeNull();
    // The menu is gone, not merely covered.
    expect(byId(el, "help-search")).toBeNull();
    // The form's Back is the way out; a second "Send feedback" would be
    // a button for the face already showing.
    expect(byId(el, "help-feedback")).toBeNull();
    // Close stays: the sheet is still the sheet.
    expect(byId(el, "help-sheet-close")).not.toBeNull();
  });

  it("Back returns to the menu with the Help heading", () => {
    const el = mount();
    click(byId(el, "help-feedback"));
    click(byId(el, "feedback-back"));

    expect(el.querySelector("#help-sheet-heading")!.textContent).toBe("Help");
    expect(byId(el, "help-search")).not.toBeNull();
    expect(byId(el, "feedback-form")).toBeNull();
    expect(byId(el, "help-feedback")).not.toBeNull();
  });

  it("still closes on Escape while the form is showing", () => {
    // The sheet's own keyboard behaviour is unchanged by which face it
    // shows — one dialog, one handler.
    const el = mount();
    click(byId(el, "help-feedback"));
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Close works from the form face too", () => {
    const el = mount();
    click(byId(el, "help-feedback"));
    click(byId(el, "help-sheet-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
