/**
 * The "Send feedback" form the help sheet swaps in for its menu
 * (docs/superpowers/specs/2026-10-11-feedback-design.md).
 *
 * It lives in help rather than Settings because help is where someone
 * goes when they are stuck, and "tell the team" is the last resort on
 * that path. It is one message and up to five screenshots, sent as one
 * multipart POST; the server stores it before any mail, so a failed
 * mail is a configuration note, not a lost report.
 *
 * Online-only, like Capture: the gate is `useSyncState().online`, the
 * same read Capture.tsx makes, and the sentence says why. Not the
 * outbox — a message that waits for a connection is one nobody reads
 * in time.
 *
 * Limits are the server's own numbers (lib/feedback.ts), applied the
 * moment a file is chosen while the picker is still in front of the
 * person. A refused file is named in a line under the thumbnails, not a
 * modal: picking five at once and losing one should not interrupt the
 * four that made it.
 *
 * Thumbnails are object URLs, created once per list change and revoked
 * in the effect's cleanup — the PaymentEdit.tsx preview pattern — so
 * a removed or sent image does not leave a blob URL pinned in memory.
 */
import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { Button, FilePicker, Textarea } from "../../components/index.ts";
import { useData, useSyncState } from "../../lib/app-context.tsx";
import {
  FEEDBACK_FAILED_MESSAGE,
  FEEDBACK_MAX_IMAGES,
  FEEDBACK_MAX_MESSAGE,
  FEEDBACK_OFFLINE_MESSAGE,
  FEEDBACK_SAVED_MESSAGE,
  FEEDBACK_SENT_MESSAGE,
  addFeedbackImages,
  feedbackProblem,
} from "../../lib/feedback.ts";
import { CLIENT_VERSION } from "../../lib/versions.ts";

// The form's sentences live in lib/feedback.ts beside the limits, so the
// capture "Report error" sheet (components/CaptureReportSheet.tsx) says
// the same thing about the same endpoint without importing this form —
// a component importing help/runtime, which imports the component
// barrel, would be an import cycle. Re-exported for this form's test.
export {
  FEEDBACK_FAILED_MESSAGE,
  FEEDBACK_OFFLINE_MESSAGE,
  FEEDBACK_SAVED_MESSAGE,
  FEEDBACK_SENT_MESSAGE,
};

type Notice = { kind: "success" | "error"; text: string };

export function FeedbackForm({ onBack }: { onBack: () => void }) {
  const data = useData();
  const sync = useSyncState();
  const { pathname } = useLocation();
  const [message, setMessage] = useState("");
  const [images, setImages] = useState<File[]>([]);
  const [refused, setRefused] = useState<string[]>([]);
  const [thumbnails, setThumbnails] = useState<string[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [sending, setSending] = useState(false);

  // Same gate as Capture.tsx: `sync` is null while signed out, which is
  // not "offline" — the sheet simply has no engine to ask yet.
  const offline = sync !== null && !sync.online;

  // One object URL per attached image, revoked when the list changes or
  // the form unmounts. `images` is replaced wholesale on every add or
  // remove, so the effect sees each list exactly once.
  useEffect(() => {
    const urls = images.map((file) => URL.createObjectURL(file));
    setThumbnails(urls);
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, [images]);

  function choose(files: File[]) {
    const result = addFeedbackImages(images, files);
    setImages(result.images);
    setRefused(result.refused);
    // A fresh choice is a fresh attempt: a stale "sent" or "failed"
    // notice above a message being rebuilt would describe the wrong one.
    setNotice(null);
  }

  function remove(index: number) {
    setImages(images.filter((_, i) => i !== index));
    setRefused([]);
  }

  const problem = feedbackProblem(message, images);
  const canSend = !offline && !sending && problem === null;

  async function send() {
    if (!canSend) return;
    setSending(true);
    setNotice(null);
    try {
      const receipt = await data.sendFeedback({
        message: message.trim(),
        page: pathname,
        clientVersion: CLIENT_VERSION,
        images,
      });
      setNotice({
        kind: "success",
        text:
          receipt.emailStatus === "sent"
            ? FEEDBACK_SENT_MESSAGE
            : `${FEEDBACK_SENT_MESSAGE} ${FEEDBACK_SAVED_MESSAGE}`,
      });
      // Sent means gone: the form empties so a second tap cannot send
      // the same report twice, and Back is the way out.
      setMessage("");
      setImages([]);
      setRefused([]);
    } catch (error) {
      // ApiError carries the server's own sentence for a 400/413/429
      // (api.ts `feedbackFailureMessage`); anything else — a network
      // failure mid-upload — gets the generic one.
      setNotice({
        kind: "error",
        text:
          error instanceof Error && error.message !== ""
            ? error.message
            : FEEDBACK_FAILED_MESSAGE,
      });
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-3 py-3" data-testid="feedback-form">
      <p className="text-xs text-slate-600">
        Tell the team what went wrong or what you'd like changed. Screenshots
        help — up to {FEEDBACK_MAX_IMAGES}. Where you are in the app and
        which version you're on go along automatically.
      </p>

      {offline && (
        <p
          data-testid="feedback-offline"
          className="rounded-xl bg-amber-50 p-3 text-sm text-amber-800"
        >
          {FEEDBACK_OFFLINE_MESSAGE}
        </p>
      )}

      <Textarea
        value={message}
        aria-label="Your feedback"
        placeholder="What happened?"
        data-testid="feedback-message"
        maxLength={FEEDBACK_MAX_MESSAGE}
        disabled={sending}
        onChange={(e) => {
          setMessage(e.target.value);
          if (notice !== null) setNotice(null);
        }}
      />

      {/* Images only, several at once. `accept` is advisory — the OS
          can still hand over a PDF — so `addFeedbackImages` checks the
          type too. */}
      <FilePicker
        accept="image/*"
        multiple
        testId="feedback-images"
        label="Add screenshots"
        disabled={sending || images.length >= FEEDBACK_MAX_IMAGES}
        onFiles={choose}
      />

      {images.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label="Attached images">
          {images.map((file, index) => (
            <li key={`${file.name}-${index}`} className="relative">
              <img
                src={thumbnails[index]}
                alt={file.name}
                data-testid={`feedback-image-${index}`}
                className="h-16 w-16 rounded-lg border border-slate-300 object-cover"
              />
              <button
                type="button"
                aria-label={`Remove ${file.name}`}
                data-testid={`feedback-image-remove-${index}`}
                disabled={sending}
                onClick={() => remove(index)}
                className="absolute -right-1 -top-1 h-5 w-5 rounded-full border border-slate-300
                           bg-white text-xs leading-none text-slate-700"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      {refused.length > 0 && (
        <p data-testid="feedback-refused" className="text-sm text-red-600">
          {refused.join(" ")}
        </p>
      )}

      {notice !== null && (
        <p
          data-testid="feedback-notice"
          role="status"
          className={
            notice.kind === "success"
              ? // DraftReview's success panel, token for token (design-
                // tokens.test.ts: every colour must be a tokenised step).
                "rounded-xl bg-emerald-50 p-3 text-sm text-emerald-700"
              : "text-sm text-red-600"
          }
        >
          {notice.text}
        </p>
      )}

      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" size="sm" data-testid="feedback-back" onClick={onBack}>
          ← Back to help topics
        </Button>
        <Button data-testid="feedback-send" disabled={!canSend} onClick={() => void send()}>
          {sending ? "Sending…" : "Send"}
        </Button>
      </div>
    </div>
  );
}
