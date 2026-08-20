import { useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { useData, useSyncState } from "../lib/app-context.tsx";
import { AppHeader, Button } from "../components/index.ts";

/** Photo capture entry (docs/plan.md §8): pick/shoot a flyer or
 * receipt → server extracts → review the draft. Needs a connection —
 * extraction runs where the AI keys live. */
export function Capture() {
  const data = useData();
  const sync = useSyncState();
  const navigate = useNavigate();
  const fileInput = useRef<HTMLInputElement>(null);
  const offline = sync !== null && !sync.online;

  const capture = useMutation({
    mutationFn: (file: File) => data.capturePhoto(file),
    onSuccess: (draft) => navigate(`/drafts/${draft.id}`, { replace: true }),
  });

  return (
    <>
      <AppHeader title="Capture" />
      <main className="mx-auto max-w-lg space-y-4 p-4">
        <p className="text-sm leading-relaxed text-slate-600">
          Snap a flyer, booking sheet, or receipt — Gigsy reads it and
          drafts the gig, expense, or payment for you to review. Nothing
          is saved until you confirm.
        </p>

        {offline && (
          <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-800">
            Capture needs a connection — the extraction runs server-side.
          </p>
        )}

        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          data-testid="capture-input"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file !== undefined) capture.mutate(file);
          }}
        />
        {/* The visible control. `capture-input` above is the real file
            input and is `hidden`, so it is neither highlightable nor
            something a help scenario may drive — this is what a person
            actually taps, and what a tour spotlights. */}
        <Button
          block
          data-testid="capture-start"
          disabled={offline || capture.isPending}
          onClick={() => fileInput.current?.click()}
        >
          {capture.isPending ? "Reading the photo…" : "📸 Capture gig or receipt"}
        </Button>

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
