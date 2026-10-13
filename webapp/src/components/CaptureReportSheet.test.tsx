/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type FeedbackInput, type FeedbackReceipt } from "../lib/api.ts";
import type { CorrectedCapture } from "../lib/capture-report.ts";
import {
  FEEDBACK_FAILED_MESSAGE,
  FEEDBACK_OFFLINE_MESSAGE,
  FEEDBACK_SAVED_MESSAGE,
  FEEDBACK_SENT_MESSAGE,
} from "../lib/feedback.ts";
import type { DraftExtracted } from "../lib/types.ts";
import { CLIENT_VERSION } from "../lib/versions.ts";
import { CaptureReportSheet, type CaptureReportMode } from "./CaptureReportSheet.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = {
  sendFeedback: vi.fn(
    async (_input: FeedbackInput): Promise<FeedbackReceipt> => ({ id: "f1", emailStatus: "sent" }),
  ),
};

/** Mutable so one test can take the device offline; the mock reads it
 *  on every render (FeedbackForm.test.tsx). */
let online = true;

vi.mock("../lib/app-context.tsx", () => ({
  useData: () => api,
  useSyncState: () => ({ online, pendingCount: 0 }),
}));

const RECOGNIZED: DraftExtracted = {
  kind: "gig",
  clientName: "Acme",
  location: "Expo Hall",
  amountOfferedCents: 12500,
};

const UNTOUCHED: CorrectedCapture = {
  kind: "gig",
  clientName: "Acme",
  location: "Expo Hall",
  dateTimes: [],
  amountCents: 12500,
  category: null,
  notes: null,
};

const review = (corrected: Partial<CorrectedCapture> = {}): CaptureReportMode => ({
  draftId: "d1",
  recognized: RECOGNIZED,
  corrected: { ...UNTOUCHED, ...corrected },
});

const flyer = () => new File(["png"], "flyer.png", { type: "image/png" });
const failed = (file: File = flyer()): CaptureReportMode => ({ file, error: "capture failed" });

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function render(mode: CaptureReportMode, path = "/drafts/d1") {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[path]}>
        <CaptureReportSheet open onClose={() => {}} mode={mode} />
      </MemoryRouter>,
    );
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  online = true;
  vi.clearAllMocks();
});

/** The sheet portals to <body>; every lookup goes through `document`. */
const byId = <T extends HTMLElement>(id: string) =>
  document.querySelector<T>(`[data-testid="${id}"]`);
const send = () => byId<HTMLButtonElement>("capture-report-send")!;

async function click(el: HTMLElement | null) {
  await act(async () => {
    el!.click();
  });
}

async function type(value: string) {
  const textarea = byId<HTMLTextAreaElement>("capture-report-message")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** The single request the sheet sent. */
const sentInput = () => api.sendFeedback.mock.calls[0]![0];

describe("CaptureReportSheet — review mode", () => {
  it("shows one row per corrected field, recognised beside corrected", async () => {
    await render(review({ amountCents: 15000 }));
    expect(byId("capture-report-sheet")).not.toBeNull();
    const row = byId("capture-report-row-amountCents")!;
    expect(row.textContent).toContain("Amount");
    expect(row.textContent).toContain("$125.00");
    expect(row.textContent).toContain("$150.00");
    // Unchanged fields are left out.
    expect(byId("capture-report-row-clientName")).toBeNull();
    expect(byId("capture-report-row-location")).toBeNull();
  });

  it("sends with no text when a field was corrected, with a generated message", async () => {
    await render(review({ amountCents: 15000 }));
    expect(send().disabled).toBe(false);
    await click(send());

    expect(api.sendFeedback).toHaveBeenCalledTimes(1);
    expect(sentInput()).toEqual({
      message: "Capture read 1 field wrong: Amount",
      page: "/drafts/d1",
      clientVersion: CLIENT_VERSION,
      kind: "capture-error",
      stage: "review",
      draftId: "d1",
      corrected: { ...UNTOUCHED, amountCents: 15000 },
      images: [],
    });
  });

  it("refuses to send nothing: no text and no corrections holds Send until something is typed", async () => {
    await render(review());
    expect(byId("capture-report-diff")?.textContent).toContain("haven't changed anything");
    expect(send().disabled).toBe(true);
    await click(send());
    expect(api.sendFeedback).not.toHaveBeenCalled();

    await type("The date is a day off.");
    expect(send().disabled).toBe(false);
    await click(send());
    expect(sentInput().message).toBe("The date is a day off.");
  });

  it("leaves out the draft id — and so the original — when Include the original is off", async () => {
    await render(review({ amountCents: 15000 }));
    const original = byId<HTMLInputElement>("capture-report-original")!;
    expect(original.checked).toBe(true);
    await click(original);
    expect(original.checked).toBe(false);

    await click(send());
    expect(sentInput()).not.toHaveProperty("draftId");
    expect(sentInput().corrected).toEqual({ ...UNTOUCHED, amountCents: 15000 });
  });

  it("says it was sent, and holds Send so the report cannot go twice", async () => {
    await render(review({ amountCents: 15000 }));
    await click(send());
    expect(byId("capture-report-notice")?.textContent).toBe(FEEDBACK_SENT_MESSAGE);
    expect(send().disabled).toBe(true);
  });

  it("adds the saved note when the server stored it but did not mail it", async () => {
    api.sendFeedback.mockResolvedValueOnce({ id: "f1", emailStatus: "unsent" });
    await render(review({ amountCents: 15000 }));
    await click(send());
    expect(byId("capture-report-notice")?.textContent).toBe(
      `${FEEDBACK_SENT_MESSAGE} ${FEEDBACK_SAVED_MESSAGE}`,
    );
  });

  it("shows the server's sentence on failure, and the fallback when there is none", async () => {
    api.sendFeedback.mockRejectedValueOnce(new ApiError(404, "draft not found"));
    await render(review({ amountCents: 15000 }));
    await click(send());
    expect(byId("capture-report-notice")?.textContent).toBe("draft not found");
    // A failure leaves Send available to try again.
    expect(send().disabled).toBe(false);

    api.sendFeedback.mockRejectedValueOnce(new Error(""));
    await click(send());
    expect(byId("capture-report-notice")?.textContent).toBe(FEEDBACK_FAILED_MESSAGE);
  });

  it("is held offline, and says why", async () => {
    online = false;
    await render(review({ amountCents: 15000 }));
    expect(byId("capture-report-offline")?.textContent).toBe(FEEDBACK_OFFLINE_MESSAGE);
    expect(send().disabled).toBe(true);
  });
});

describe("CaptureReportSheet — extraction failed", () => {
  it("sends with no text, the file as an image and the error, and no diff", async () => {
    const file = flyer();
    await render(failed(file), "/capture");
    expect(byId("capture-report-diff")).toBeNull();
    expect(send().disabled).toBe(false);

    await click(send());
    expect(sentInput()).toEqual({
      message: "Capture could not read this.",
      page: "/capture",
      clientVersion: CLIENT_VERSION,
      kind: "capture-error",
      stage: "extraction-failed",
      error: "capture failed",
      images: [file],
    });
  });

  it("sends no file when Include the file is off", async () => {
    await render(failed(), "/capture");
    await click(byId("capture-report-original"));
    await click(send());
    expect(sentInput().images).toEqual([]);
  });

  it("cannot attach a PDF, says so, and still sends the report", async () => {
    // The feedback endpoint takes images only; the capture screen also
    // takes PDFs.
    const pdf = new File(["%PDF"], "sheet.pdf", { type: "application/pdf" });
    await render(failed(pdf), "/capture");
    const original = byId<HTMLInputElement>("capture-report-original")!;
    expect(original.checked).toBe(false);
    expect(original.disabled).toBe(true);
    expect(byId("capture-report-sheet")?.textContent).toContain("Only images can be attached");

    await click(send());
    expect(sentInput().images).toEqual([]);
  });
});
