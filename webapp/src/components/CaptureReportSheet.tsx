/**
 * The capture "Report error" sheet (docs/superpowers/specs/2026-10-12-
 * capture-report-error-design.md): one tap turns a misread capture into
 * a report the team can test against.
 *
 * Two places open it, and `mode` says which:
 *
 *   - REVIEW (DraftReview.tsx) — a draft exists. The sheet shows the
 *     fields the person corrected, recognised → corrected, and sends the
 *     draft's id plus the corrected values. The original and what was
 *     recognised are NOT sent from here: the server copies the draft's
 *     raw object and reads its `extracted_json` itself, so a phone on a
 *     poor connection never re-uploads a photo the server already has,
 *     and a tampered client cannot rewrite what extraction said.
 *   - FAILED (Capture.tsx) — extraction failed and no draft was made,
 *     so the only copy of the original is the file just chosen. It goes
 *     up as an image part, with the error the screen showed.
 *
 * Nothing to type by default. The message is `captureReportMessage`'s
 * (lib/capture-report.ts): the person's words when they wrote some,
 * otherwise a line naming the corrected fields, otherwise — in review
 * mode with nothing corrected — nothing, and Send waits for text,
 * because a report that says nothing is noise in someone's inbox.
 *
 * "Include the original" is on by default and does what it says on both
 * paths: off in review mode leaves out `draftId` (which is how the
 * server knows to copy the original), off in failed mode leaves out the
 * file. A PDF cannot go — the feedback endpoint takes images only — so
 * for one the switch is off and says why, rather than letting the
 * server refuse the whole report with a 400.
 *
 * Online-only with the same gate and the same sentences as the help
 * sheet's feedback form (help/runtime/FeedbackForm.tsx; the sentences
 * live in lib/feedback.ts for both): it is the same endpoint and the
 * same promise to the person, and two wordings of one promise would
 * drift.
 *
 * The body is a separate component rendered as the Sheet's children,
 * and Sheet mounts children only while open — so every open starts
 * from a clean form, and a sent report's "Thanks" is not waiting there
 * the next time.
 */
import { useState } from "react";
import { useLocation } from "react-router-dom";
import { useData, useSyncState } from "../lib/app-context.tsx";
import type { FeedbackInput } from "../lib/api.ts";
import {
  captureCorrections,
  captureReportMessage,
  type CorrectedCapture,
} from "../lib/capture-report.ts";
import {
  FEEDBACK_FAILED_MESSAGE,
  FEEDBACK_MAX_MESSAGE,
  FEEDBACK_OFFLINE_MESSAGE,
  FEEDBACK_SAVED_MESSAGE,
  FEEDBACK_SENT_MESSAGE,
} from "../lib/feedback.ts";
import type { DraftExtracted } from "../lib/types.ts";
import { CLIENT_VERSION } from "../lib/versions.ts";
import { Button } from "./Button.tsx";
import { Textarea } from "./Input.tsx";
import { Sheet } from "./Sheet.tsx";
import { Toggle } from "./Toggle.tsx";

/** A draft under review: its id, what extraction read, and what the
 *  review form holds now. */
export interface CaptureReportReview {
  draftId: string;
  recognized: DraftExtracted;
  corrected: CorrectedCapture;
}

/** A capture that failed before any draft existed: the file that was
 *  chosen and the error line the screen showed. */
export interface CaptureReportFailed {
  file: File;
  error: string;
}

export type CaptureReportMode = CaptureReportReview | CaptureReportFailed;

export interface CaptureReportSheetProps {
  open: boolean;
  onClose: () => void;
  mode: CaptureReportMode;
}

const isFailed = (mode: CaptureReportMode): mode is CaptureReportFailed => "file" in mode;

/** The feedback endpoint takes images only (backend/src/routes/
 *  feedback.ts); a PDF chosen on the capture screen cannot ride along. */
const isAttachable = (file: File) => file.type.startsWith("image/");

type Notice = { kind: "success" | "error"; text: string };

export function CaptureReportSheet({ open, onClose, mode }: CaptureReportSheetProps) {
  return (
    <Sheet open={open} onClose={onClose} title="Report error" testId="capture-report-sheet">
      <CaptureReportBody mode={mode} />
    </Sheet>
  );
}

function CaptureReportBody({ mode }: { mode: CaptureReportMode }) {
  const data = useData();
  const sync = useSyncState();
  const { pathname } = useLocation();
  const failed = isFailed(mode);
  const canAttach = !failed || isAttachable(mode.file);

  const [text, setText] = useState("");
  const [includeOriginal, setIncludeOriginal] = useState(canAttach);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  // FeedbackForm's gate: `sync` is null while signed out, which is not
  // "offline".
  const offline = sync !== null && !sync.online;

  // Null in failed mode: nothing was recognised, so there is nothing to
  // compare — and `captureReportMessage` reads null as exactly that.
  const corrections = failed ? null : captureCorrections(mode.recognized, mode.corrected);
  const message = captureReportMessage(text, corrections);
  const canSend = !offline && !sending && !sent && message !== null;

  /** The request, by mode. Only the parts that apply are set — the api
   *  appends nothing for an undefined one (api.ts `sendFeedback`). */
  function input(body: string): FeedbackInput {
    const common = {
      message: body,
      page: pathname,
      clientVersion: CLIENT_VERSION,
      kind: "capture-error" as const,
    };
    if (failed) {
      return {
        ...common,
        stage: "extraction-failed",
        error: mode.error,
        images: includeOriginal && canAttach ? [mode.file] : [],
      };
    }
    return {
      ...common,
      stage: "review",
      corrected: mode.corrected,
      images: [],
      // No draftId, no original: the server copies the draft's object
      // only when it is told which draft.
      ...(includeOriginal ? { draftId: mode.draftId } : {}),
    };
  }

  async function send() {
    if (!canSend) return;
    setSending(true);
    setNotice(null);
    try {
      const receipt = await data.sendFeedback(input(message));
      setNotice({
        kind: "success",
        text:
          receipt.emailStatus === "sent"
            ? FEEDBACK_SENT_MESSAGE
            : `${FEEDBACK_SENT_MESSAGE} ${FEEDBACK_SAVED_MESSAGE}`,
      });
      // Sent means gone: Send stays off so a second tap cannot file the
      // same report twice. Close is the way out.
      setSent(true);
    } catch (error) {
      // The server's own sentence for a 400/404/413/429 (api.ts
      // `feedbackFailureMessage`) — "draft not found" included.
      setNotice({
        kind: "error",
        text:
          error instanceof Error && error.message !== "" ? error.message : FEEDBACK_FAILED_MESSAGE,
      });
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <p className="text-sm text-slate-600">
        {failed
          ? "This goes to the team with the file you chose and the error you saw, so they can see why it couldn't be read."
          : "This goes to the team with the original, what Gigsy read, and what you changed it to. Nothing else to do unless you want to add a note."}
      </p>

      {offline && (
        <p
          data-testid="capture-report-offline"
          className="rounded-xl bg-amber-50 p-3 text-sm text-amber-800"
        >
          {FEEDBACK_OFFLINE_MESSAGE}
        </p>
      )}

      {failed ? (
        <p className="text-sm text-red-600">{mode.error}</p>
      ) : (
        <CorrectionsTable corrections={corrections ?? []} />
      )}

      <Textarea
        value={text}
        aria-label="What was wrong"
        placeholder={
          failed || (corrections?.length ?? 0) > 0 ? "Anything to add? (optional)" : "What was wrong?"
        }
        data-testid="capture-report-message"
        maxLength={FEEDBACK_MAX_MESSAGE}
        disabled={sending || sent}
        onChange={(e) => {
          setText(e.target.value);
          if (notice?.kind === "error") setNotice(null);
        }}
      />

      <div className="flex items-center justify-between gap-3">
        <div className="text-sm">
          <p className="font-medium text-slate-900">
            {failed ? "Include the file" : "Include the original"}
          </p>
          {!canAttach && (
            <p className="text-xs text-slate-500">Only images can be attached — not this file.</p>
          )}
        </div>
        <Toggle
          checked={includeOriginal && canAttach}
          disabled={!canAttach || sending || sent}
          label={failed ? "Include the file" : "Include the original"}
          data-testid="capture-report-original"
          onChange={setIncludeOriginal}
        />
      </div>

      {notice !== null && (
        <p
          data-testid="capture-report-notice"
          role="status"
          className={
            notice.kind === "success"
              ? // FeedbackForm's success panel, token for token.
                "rounded-xl bg-emerald-50 p-3 text-sm text-emerald-700"
              : "text-sm text-red-600"
          }
        >
          {notice.text}
        </p>
      )}

      <Button block data-testid="capture-report-send" disabled={!canSend} onClick={() => void send()}>
        {sending ? "Sending…" : "Send"}
      </Button>
    </div>
  );
}

/**
 * Recognised → corrected, one row per field that differs. The server
 * builds the mail's own diff from ITS copy of what was read (the draft
 * row), so this table is the person's preview of it, not its source. With
 * nothing corrected the table gives way to a sentence, because an empty
 * table looks like something failed to load.
 */
function CorrectionsTable({
  corrections,
}: {
  corrections: ReturnType<typeof captureCorrections>;
}) {
  if (corrections.length === 0) {
    return (
      <p data-testid="capture-report-diff" className="text-sm text-slate-500">
        You haven't changed anything from what was read — say what was wrong below.
      </p>
    );
  }
  return (
    <table data-testid="capture-report-diff" className="w-full text-sm">
      <thead>
        <tr className="text-left text-xs text-slate-500">
          <th className="py-1 pr-2 font-medium">Field</th>
          <th className="py-1 pr-2 font-medium">Read as</th>
          <th className="py-1 font-medium">Changed to</th>
        </tr>
      </thead>
      <tbody>
        {corrections.map((row) => (
          <tr
            key={row.field}
            data-testid={`capture-report-row-${row.field}`}
            className="border-t border-slate-200 align-top"
          >
            <th scope="row" className="py-2 pr-2 text-left font-medium text-slate-700">
              {row.label}
            </th>
            <td className="py-2 pr-2 text-slate-500 line-through">{row.recognized}</td>
            <td className="py-2 text-slate-900">{row.corrected}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
