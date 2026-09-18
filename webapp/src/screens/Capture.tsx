import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { useData, useSyncState } from "../lib/app-context.tsx";
import { MAX_IMAGE_BYTES } from "../lib/image-queue.ts";
import { AppHeader, Button, FilePicker } from "../components/index.ts";

/**
 * Refused at the moment the file is chosen, while the picker is still
 * in front of the person and they can pick again — not a day later as
 * a 413 from the server. The ceiling is the queue's (lib/image-queue.ts)
 * for the same reason it is there: a full-resolution phone photo or a
 * booking-sheet PDF is a few MB, and what this catches is the mis-tap —
 * a video, a print-resolution scan. Derived from the constant so the
 * number in the sentence cannot drift from the number in the check.
 */
export const CAPTURE_TOO_LARGE_MESSAGE = `That file is too large to read — keep it under ${Math.round(
  MAX_IMAGE_BYTES / (1024 * 1024),
)} MB.`;

/**
 * Capture entry (docs/plan.md §8): pick or shoot a flyer, booking
 * sheet, receipt or PDF → server extracts → review the draft. Needs a
 * connection — extraction runs where the AI keys live.
 *
 * Two controls, on purpose (docs/superpowers/specs/2026-09-18-gig-
 * batches-design.md). This screen used to be one hidden
 * `<input type="file" accept="image/*" capture="environment">` behind a
 * button, and `capture="environment"` FORCES the camera: on many phones
 * that meant no way to pick a flyer already in the photo library or a
 * PDF someone emailed. So:
 *
 *   1. `FilePicker` — the visible native chooser, with no `capture`
 *      attribute, which is what makes the OS offer "camera / library /
 *      files" as a sheet. This is `capture-input`, the id the e2e suite
 *      drives with `setInputFiles`.
 *   2. "Take a photo" — the camera kept as its own button over a hidden
 *      `capture="environment"` input, for the person standing in front
 *      of the flyer who wants the camera and nothing else.
 *
 * Both hand the file to the same `choose`, so the size check and the
 * upload are written once.
 */
export function Capture() {
  const data = useData();
  const sync = useSyncState();
  const navigate = useNavigate();
  const cameraInput = useRef<HTMLInputElement>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const offline = sync !== null && !sync.online;

  const capture = useMutation({
    mutationFn: (file: File) => data.capturePhoto(file),
    onSuccess: (draft) => navigate(`/drafts/${draft.id}`, { replace: true }),
  });

  function choose(file: File) {
    if (file.size > MAX_IMAGE_BYTES) {
      setRefusal(CAPTURE_TOO_LARGE_MESSAGE);
      return;
    }
    setRefusal(null);
    capture.mutate(file);
  }

  const busy = offline || capture.isPending;

  return (
    <>
      <AppHeader title="Capture" />
      <main className="mx-auto max-w-lg space-y-4 p-4">
        <p className="text-sm leading-relaxed text-slate-600">
          Pick a picture you already have, a PDF, or take a photo — of a
          flyer, booking sheet, or receipt. Gigsy reads it and drafts the
          gig, expense, or payment for you to review. A sheet that lists
          several dates becomes several gigs to review at once. Nothing is
          saved until you confirm.
        </p>

        {offline && (
          <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-800">
            Capture needs a connection — the extraction runs server-side.
          </p>
        )}

        {/* The visible chooser. No `capture` attribute, so the OS offers
            the library and files as well as the camera. Images and PDF:
            the extraction providers take both (design doc, "File types
            for capture"). */}
        <FilePicker
          accept="image/*,.pdf"
          testId="capture-input"
          label="Choose a photo or file"
          disabled={busy}
          onFile={choose}
        />

        {/* The camera, kept. Hidden because the button below is the
            thing a person taps and a tour spotlights (see help/
            targets.ts) — this input is neither highlightable nor
            something a help scenario may drive. */}
        <input
          ref={cameraInput}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          data-testid="capture-camera-input"
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file !== undefined) choose(file);
          }}
        />
        <Button
          block
          variant="ghost"
          data-testid="capture-start"
          disabled={busy}
          onClick={() => cameraInput.current?.click()}
        >
          {capture.isPending ? "Reading the photo…" : "📷 Take a photo"}
        </Button>

        {refusal !== null && (
          <p data-testid="capture-refused" className="text-sm text-red-600">
            {refusal}
          </p>
        )}

        {capture.isError && (
          <p className="text-sm text-red-600">
            {capture.error instanceof Error
              ? capture.error.message
              : "Capture failed — try again."}
          </p>
        )}

        <p className="text-xs text-slate-400">
          Forwarding emails works too once your personal capture address
          is set up (coming with the email domain).
        </p>
      </main>
    </>
  );
}
