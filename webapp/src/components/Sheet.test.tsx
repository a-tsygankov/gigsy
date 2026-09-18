/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Sheet, type SheetProps } from "./Sheet.tsx";

// Same setup as HelpProvider.test.tsx: react-dom's `act` warns without
// this, because nothing here is React Testing Library.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

/** The sheet is portalled to <body>, so nothing inside it is reachable
 *  through the render container — every lookup goes through `document`. */
const byId = <T extends HTMLElement>(id: string): T | null =>
  document.querySelector<T>(`[data-testid="${id}"]`);

function render(props: Partial<SheetProps> = {}): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <Sheet open onClose={() => {}} title="Pick one" testId="s" {...props}>
        <p data-testid="s-body">body</p>
      </Sheet>,
    ),
  );
  return container;
}

/** Re-render the same tree with `open` flipped — what a caller does when
 *  it closes the sheet. Same `root`, so the panel unmounts rather than
 *  the whole tree being torn down. */
function setOpen(open: boolean, onClose: () => void = () => {}) {
  act(() =>
    root!.render(
      <Sheet open={open} onClose={onClose} title="Pick one" testId="s">
        <p data-testid="s-body">body</p>
      </Sheet>,
    ),
  );
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  document.body.style.overflow = "";
});

describe("Sheet", () => {
  it("renders nothing while closed", () => {
    render({ open: false });
    expect(byId("s")).toBeNull();
    expect(byId("s-body")).toBeNull();
  });

  it("is a modal dialog named by its heading, portalled to <body>", () => {
    const el = render();
    const dialog = byId("s")!;
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const heading = document.getElementById(dialog.getAttribute("aria-labelledby") ?? "");
    expect(heading?.textContent).toBe("Pick one");
    // Outside the render container: a sheet inside a <label> or a
    // scrolling <main> would otherwise inherit their layout.
    expect(el.contains(dialog)).toBe(false);
    expect(byId("s-body")).not.toBeNull();
  });

  it("moves focus to the heading on open", () => {
    render();
    const dialog = byId("s")!;
    const heading = document.getElementById(dialog.getAttribute("aria-labelledby") ?? "");
    expect(document.activeElement).toBe(heading);
  });

  it("returns focus to whatever had it before, on close", () => {
    // A trigger outside the sheet, focused before it opens — the shape
    // GigPicker produces.
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    render({ open: false });
    setOpen(true);
    expect(document.activeElement).not.toBe(trigger);
    setOpen(false);
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("calls onClose on Escape", () => {
    const onClose = vi.fn();
    render({ onClose });
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose from its Close button", () => {
    const onClose = vi.fn();
    render({ onClose });
    act(() => byId<HTMLButtonElement>("s-close")!.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("locks body scroll while open and restores it after", () => {
    document.body.style.overflow = "scroll";
    render({ open: false });
    setOpen(true);
    expect(document.body.style.overflow).toBe("hidden");
    setOpen(false);
    // Restored to what it WAS, not blanked: a page that had its own
    // overflow rule keeps it.
    expect(document.body.style.overflow).toBe("scroll");
  });

  it("stops listening for Escape once closed", () => {
    const onClose = vi.fn();
    render({ open: false });
    setOpen(true, onClose);
    setOpen(false, onClose);
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
  });
});
