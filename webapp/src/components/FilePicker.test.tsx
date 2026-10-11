/** @vitest-environment jsdom */
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FilePicker, type FilePickerProps } from "./FilePicker.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function render(props: FilePickerProps & { ref?: React.Ref<HTMLInputElement> }): HTMLInputElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<FilePicker {...props} />));
  return container.querySelector("input")!;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

/**
 * A file input's `files` is read-only and jsdom has no `DataTransfer`
 * to fill it through, so the list is defined onto the element directly.
 * React hears a file input through the native `change` event (not
 * `input`, which is what a text box needs — see DateTimeField.test.tsx).
 */
function choose(input: HTMLInputElement, files: File[]): void {
  Object.defineProperty(input, "files", { value: files, configurable: true });
  act(() => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("FilePicker", () => {
  it("is a real file input carrying the test id and the accept list", () => {
    const input = render({ accept: "image/*,.pdf", onFile: () => {}, testId: "pick" });
    expect(input.type).toBe("file");
    expect(input.dataset["testid"]).toBe("pick");
    expect(input.getAttribute("accept")).toBe("image/*,.pdf");
    // No `capture`: the OS must offer the library and files, not only
    // the camera. A screen that wants the camera renders its own hidden
    // input for it (Capture.tsx).
    expect(input.hasAttribute("capture")).toBe(false);
  });

  it("hands the chosen file up", () => {
    const onFile = vi.fn();
    const input = render({ accept: "image/*", onFile });
    const flyer = new File(["png"], "flyer.png", { type: "image/png" });
    choose(input, [flyer]);
    expect(onFile).toHaveBeenCalledTimes(1);
    expect(onFile).toHaveBeenCalledWith(flyer);
  });

  it("says nothing for an empty selection", () => {
    // A cancelled picker is not a choice.
    const onFile = vi.fn();
    const input = render({ accept: "image/*", onFile });
    choose(input, []);
    expect(onFile).not.toHaveBeenCalled();
  });

  it("is single-select unless asked otherwise", () => {
    // `multiple` is the attribute the OS sheet reads; without it the
    // picker is single-select whatever the handler can take.
    const input = render({ accept: "image/*", onFile: () => {} });
    expect(input.hasAttribute("multiple")).toBe(false);
  });

  it("lets the OS offer several files when told to", () => {
    const input = render({ accept: "image/*", multiple: true, onFiles: () => {} });
    expect(input.hasAttribute("multiple")).toBe(true);
  });

  it("hands every chosen file to onFiles, and the first to onFile", () => {
    // Both handlers at once: a screen that wants the batch AND keeps a
    // legacy single-file handler sees the same choice from both.
    const onFile = vi.fn();
    const onFiles = vi.fn();
    const input = render({ accept: "image/*", multiple: true, onFile, onFiles });
    const a = new File(["a"], "a.png", { type: "image/png" });
    const b = new File(["b"], "b.png", { type: "image/png" });
    choose(input, [a, b]);
    expect(onFiles).toHaveBeenCalledTimes(1);
    expect(onFiles).toHaveBeenCalledWith([a, b]);
    expect(onFile).toHaveBeenCalledTimes(1);
    expect(onFile).toHaveBeenCalledWith(a);
  });

  it("never calls onFiles with an empty list", () => {
    // The same rule as `onFile`: a cancelled picker is not a choice,
    // and a screen's list of attachments must not be touched by it.
    const onFiles = vi.fn();
    const input = render({ accept: "image/*", multiple: true, onFiles });
    choose(input, []);
    expect(onFiles).not.toHaveBeenCalled();
  });

  it("disables the input when told to", () => {
    const input = render({ accept: "image/*", onFile: () => {}, disabled: true });
    expect(input.disabled).toBe(true);
  });

  it("names itself for a screen reader", () => {
    const input = render({ accept: "image/*", onFile: () => {}, label: "Choose a photo" });
    expect(input.getAttribute("aria-label")).toBe("Choose a photo");
  });

  it("forwards a ref to the input, so a screen can clear it", () => {
    const ref = createRef<HTMLInputElement>();
    const input = render({ accept: "image/*", onFile: () => {}, ref });
    expect(ref.current).toBe(input);
  });
});
