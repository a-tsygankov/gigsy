/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type FeedbackReceipt } from "../../lib/api.ts";
import { CLIENT_VERSION } from "../../lib/versions.ts";
import {
  FEEDBACK_FAILED_MESSAGE,
  FEEDBACK_OFFLINE_MESSAGE,
  FEEDBACK_SAVED_MESSAGE,
  FEEDBACK_SENT_MESSAGE,
  FeedbackForm,
} from "./FeedbackForm.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = {
  sendFeedback: vi.fn(async (): Promise<FeedbackReceipt> => ({ id: "f1", emailStatus: "sent" })),
};

/** Mutable so one test can take the device offline; the mock reads it
 *  on every render rather than capturing a value once (Capture.test.tsx). */
let online = true;

vi.mock("../../lib/app-context.tsx", () => ({
  useData: () => api,
  useSyncState: () => ({ online, pendingCount: 0 }),
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;
const onBack = vi.fn();
const revoke = vi.fn();
let nextUrl = 0;

async function render(path = "/gigs") {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[path]}>
        <FeedbackForm onBack={onBack} />
      </MemoryRouter>,
    );
  });
  return container;
}

beforeEach(() => {
  // jsdom has no object URLs; the form's thumbnails are made of them.
  nextUrl = 0;
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn(() => `blob:thumb-${nextUrl++}`),
    revokeObjectURL: revoke,
  });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  online = true;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const byId = <T extends HTMLElement>(el: HTMLElement, id: string) =>
  el.querySelector<T>(`[data-testid="${id}"]`);

/** React hears a file input through the native `change` event; `files`
 *  is read-only, so it is defined onto the element (FilePicker.test.tsx). */
async function choose(input: HTMLInputElement, files: File[]) {
  Object.defineProperty(input, "files", { value: files, configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

/** React's controlled textarea listens for the native `input` event. */
async function type(textarea: HTMLTextAreaElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(el: HTMLElement | null) {
  await act(async () => {
    el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

const png = (name: string) => new File(["png"], name, { type: "image/png" });

describe("FeedbackForm", () => {
  it("disables Send until something is written", async () => {
    const el = await render();
    expect(byId<HTMLButtonElement>(el, "feedback-send")!.disabled).toBe(true);
    await type(byId<HTMLTextAreaElement>(el, "feedback-message")!, "The list is empty.");
    expect(byId<HTMLButtonElement>(el, "feedback-send")!.disabled).toBe(false);
  });

  it("shows a thumbnail per attached image, and removes one on its button", async () => {
    const el = await render();
    const picker = byId<HTMLInputElement>(el, "feedback-images")!;
    expect(picker.hasAttribute("multiple")).toBe(true);
    expect(picker.getAttribute("accept")).toBe("image/*");

    await choose(picker, [png("a.png"), png("b.png")]);
    expect(byId<HTMLImageElement>(el, "feedback-image-0")!.src).toBe("blob:thumb-0");
    expect(byId<HTMLImageElement>(el, "feedback-image-1")!.src).toBe("blob:thumb-1");
    expect(byId(el, "feedback-image-2")).toBeNull();

    await click(byId(el, "feedback-image-remove-0"));
    // b.png is now first, with a fresh URL; the old pair was revoked.
    expect(byId<HTMLImageElement>(el, "feedback-image-0")!.alt).toBe("b.png");
    expect(byId(el, "feedback-image-1")).toBeNull();
    expect(revoke).toHaveBeenCalledWith("blob:thumb-0");
    expect(revoke).toHaveBeenCalledWith("blob:thumb-1");
  });

  it("revokes every thumbnail URL on unmount", async () => {
    const el = await render();
    await choose(byId<HTMLInputElement>(el, "feedback-images")!, [png("a.png")]);
    revoke.mockClear();
    act(() => root!.unmount());
    root = null;
    expect(revoke).toHaveBeenCalledWith("blob:thumb-0");
  });

  it("names a refused non-image under the thumbnails and keeps the good one", async () => {
    const el = await render();
    await choose(byId<HTMLInputElement>(el, "feedback-images")!, [
      png("a.png"),
      new File(["%PDF"], "sheet.pdf", { type: "application/pdf" }),
    ]);
    expect(byId(el, "feedback-image-0")).not.toBeNull();
    expect(byId(el, "feedback-image-1")).toBeNull();
    expect(byId(el, "feedback-refused")!.textContent).toBe("sheet.pdf isn't an image.");
  });

  it("sends the message, the current route, the client version and the images, then thanks", async () => {
    const el = await render("/gigs/abc");
    const a = png("a.png");
    const b = png("b.png");
    await type(byId<HTMLTextAreaElement>(el, "feedback-message")!, "  Sync shows 0 gigs  ");
    await choose(byId<HTMLInputElement>(el, "feedback-images")!, [a, b]);

    await click(byId(el, "feedback-send"));

    expect(api.sendFeedback).toHaveBeenCalledTimes(1);
    expect(api.sendFeedback).toHaveBeenCalledWith({
      message: "Sync shows 0 gigs",
      page: "/gigs/abc",
      clientVersion: CLIENT_VERSION,
      images: [a, b],
    });
    expect(byId(el, "feedback-notice")!.textContent).toBe(FEEDBACK_SENT_MESSAGE);
    // Sent means gone: the form is empty, so a second tap cannot resend.
    expect(byId<HTMLTextAreaElement>(el, "feedback-message")!.value).toBe("");
    expect(byId(el, "feedback-image-0")).toBeNull();
    expect(byId<HTMLButtonElement>(el, "feedback-send")!.disabled).toBe(true);
  });

  it("adds the saved note when the server could not mail it", async () => {
    api.sendFeedback.mockResolvedValueOnce({ id: "f2", emailStatus: "unsent" });
    const el = await render();
    await type(byId<HTMLTextAreaElement>(el, "feedback-message")!, "hello");
    await click(byId(el, "feedback-send"));
    expect(byId(el, "feedback-notice")!.textContent).toBe(
      `${FEEDBACK_SENT_MESSAGE} ${FEEDBACK_SAVED_MESSAGE}`,
    );
  });

  it("shows the server's sentence when it refuses, and keeps what was typed", async () => {
    api.sendFeedback.mockRejectedValueOnce(new ApiError(429, "You've sent a lot of feedback today — try again tomorrow."));
    const el = await render();
    await type(byId<HTMLTextAreaElement>(el, "feedback-message")!, "hello");
    await click(byId(el, "feedback-send"));
    expect(byId(el, "feedback-notice")!.textContent).toBe(
      "You've sent a lot of feedback today — try again tomorrow.",
    );
    expect(byId<HTMLTextAreaElement>(el, "feedback-message")!.value).toBe("hello");
  });

  it("falls back to a generic sentence when the failure has none", async () => {
    api.sendFeedback.mockRejectedValueOnce(new Error(""));
    const el = await render();
    await type(byId<HTMLTextAreaElement>(el, "feedback-message")!, "hello");
    await click(byId(el, "feedback-send"));
    expect(byId(el, "feedback-notice")!.textContent).toBe(FEEDBACK_FAILED_MESSAGE);
  });

  it("disables Send and says why while offline", async () => {
    online = false;
    const el = await render();
    await type(byId<HTMLTextAreaElement>(el, "feedback-message")!, "hello");
    expect(byId<HTMLButtonElement>(el, "feedback-send")!.disabled).toBe(true);
    expect(byId(el, "feedback-offline")!.textContent).toBe(FEEDBACK_OFFLINE_MESSAGE);
    await click(byId(el, "feedback-send"));
    expect(api.sendFeedback).not.toHaveBeenCalled();
  });

  it("Back hands control to the sheet", async () => {
    const el = await render();
    await click(byId(el, "feedback-back"));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
