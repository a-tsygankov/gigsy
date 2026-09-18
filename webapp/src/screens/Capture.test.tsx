/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";
import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CAPTURE_TOO_LARGE_MESSAGE, Capture } from "./Capture.tsx";
import { HelpProvider } from "../help/runtime/HelpProvider.tsx";
import { MAX_IMAGE_BYTES } from "../lib/image-queue.ts";
import type { Draft } from "../lib/types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// TanStack Query v5 schedules the re-render through a real
// setTimeout(fn, 0). `await act` drains only microtasks, so without
// this the assertions race the timer and the file is non-deterministic.
notifyManager.setScheduler((cb) => cb());

const DRAFT: Draft = {
  id: "d1",
  source: "photo",
  status: "pending",
  rawR2Key: null,
  extracted: { kind: "gig" },
  createdAt: 0,
  modifiedAt: 0,
};

const api = {
  capturePhoto: vi.fn(async () => DRAFT),
};

/** Mutable so one test can take the device offline; the mock reads it
 *  on every render rather than capturing a value once. */
let online = true;

vi.mock("../lib/app-context.tsx", () => ({
  useData: () => api,
  useSyncState: () => ({ online, pendingCount: 0 }),
  useServices: () => ({ ready: true }),
  useAuthState: () => ({ user: { email: "t@e.com" }, ready: true, signedIn: true }),
  useSyncEngine: () => null,
}));

/** Marks the draft the capture navigated to. */
function LandedDraft() {
  const { id } = useParams();
  return <div data-testid="landed-draft">{id}</div>;
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/capture"]}>
          <HelpProvider>
            <Routes>
              <Route path="/capture" element={<Capture />} />
              <Route path="/drafts/:id" element={<LandedDraft />} />
            </Routes>
          </HelpProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  online = true;
  vi.clearAllMocks();
});

const byId = <T extends HTMLElement>(el: HTMLElement, id: string) =>
  el.querySelector<T>(`[data-testid="${id}"]`);

/**
 * A file input's `files` is read-only and jsdom has no `DataTransfer`
 * to fill it through, so the list is defined onto the element directly;
 * React hears a file input through the native `change` event (see
 * FilePicker.test.tsx).
 */
async function choose(input: HTMLInputElement, file: File) {
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

const flyer = () => new File(["png"], "flyer.png", { type: "image/png" });

/** A file one byte over the ceiling, without allocating 8 MB: `size`
 *  is what the check reads, and the bytes are never read. */
function oversize(): File {
  const file = new File(["x"], "scan.pdf", { type: "application/pdf" });
  Object.defineProperty(file, "size", { value: MAX_IMAGE_BYTES + 1 });
  return file;
}

describe("Capture", () => {
  it("sends a file chosen through the visible chooser and opens its draft", async () => {
    const el = await render();
    const picker = byId<HTMLInputElement>(el, "capture-input")!;
    // A real file input that accepts images and PDFs, with no `capture`
    // — the e2e suite's `setInputFiles` depends on the first, and the
    // OS offering the library on the last.
    expect(picker.type).toBe("file");
    expect(picker.getAttribute("accept")).toBe("image/*,.pdf");
    expect(picker.hasAttribute("capture")).toBe(false);

    const file = flyer();
    await choose(picker, file);

    expect(api.capturePhoto).toHaveBeenCalledTimes(1);
    expect(api.capturePhoto).toHaveBeenCalledWith(file);
    expect(byId(el, "landed-draft")?.textContent).toBe("d1");
  });

  it("sends a photo taken through the camera input the same way", async () => {
    const el = await render();
    const camera = byId<HTMLInputElement>(el, "capture-camera-input")!;
    // The camera path keeps `capture="environment"`; that is its point.
    expect(camera.getAttribute("capture")).toBe("environment");
    expect(camera.getAttribute("accept")).toBe("image/*");

    const file = flyer();
    await choose(camera, file);

    expect(api.capturePhoto).toHaveBeenCalledWith(file);
    expect(byId(el, "landed-draft")?.textContent).toBe("d1");
  });

  it("opens the camera input from the Take a photo button", async () => {
    const el = await render();
    const camera = byId<HTMLInputElement>(el, "capture-camera-input")!;
    const opened = vi.spyOn(camera, "click");
    await act(async () => {
      byId(el, "capture-start")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(opened).toHaveBeenCalledTimes(1);
    expect(byId(el, "capture-start")?.textContent).toContain("Take a photo");
  });

  it("refuses an oversize file with a message, and sends nothing", async () => {
    const el = await render();
    await choose(byId<HTMLInputElement>(el, "capture-input")!, oversize());

    expect(api.capturePhoto).not.toHaveBeenCalled();
    expect(byId(el, "capture-refused")?.textContent).toBe(CAPTURE_TOO_LARGE_MESSAGE);
    // The number in the sentence is the ceiling, not a copy of it.
    expect(CAPTURE_TOO_LARGE_MESSAGE).toBe(
      "That file is too large to read — keep it under 8 MB.",
    );
    // Still here to pick again.
    expect(byId(el, "landed-draft")).toBeNull();
  });

  it("clears the refusal once an acceptable file is chosen", async () => {
    const el = await render();
    const picker = byId<HTMLInputElement>(el, "capture-input")!;
    await choose(picker, oversize());
    expect(byId(el, "capture-refused")).not.toBeNull();
    await choose(picker, flyer());
    expect(api.capturePhoto).toHaveBeenCalledTimes(1);
  });

  it("disables both controls while offline", async () => {
    online = false;
    const el = await render();
    expect(byId<HTMLInputElement>(el, "capture-input")?.disabled).toBe(true);
    expect(byId<HTMLButtonElement>(el, "capture-start")?.disabled).toBe(true);
    expect(byId<HTMLInputElement>(el, "capture-camera-input")?.disabled).toBe(true);
    expect(el.textContent).toContain("Capture needs a connection");
  });
});
