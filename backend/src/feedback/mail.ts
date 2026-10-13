/**
 * Turning a stored feedback row into the one mail every admin gets.
 *
 * Pure: a record and bytes in, an `OutgoingEmail` out, no binding and
 * no clock. That is what lets test/feedback-mail.test.ts assert the
 * subject and body without a sender, and what keeps routes/feedback.ts
 * to the ordering it owns (store, then mail) rather than to formatting.
 *
 * The mail IS the admin UI (docs/superpowers/specs/2026-10-11-
 * feedback-design.md): nothing else reads the table, so everything an
 * admin would want to know to act — who, when, where in the app, which
 * client build, which browser — goes in the body above the message,
 * and the screenshots ride along as attachments.
 *
 * Two kinds, one builder (migration 0022, docs/superpowers/specs/
 * 2026-10-12-capture-report-error-design.md). The row's `kind` picks
 * the shape and its `contextJson` feeds the capture-error block — the
 * record stays the single input, so what is mailed is always what was
 * stored. A `general` row produces the mail it did before 0022, to the
 * byte (test/feedback-capture-mail.test.ts pins that); a
 * `capture-error` row gets its own subject prefix and, under the usual
 * header, the stage, draft, source, original and error, then the
 * "Recognised → Corrected" lines (feedback/capture-diff.ts), then the
 * message.
 */
import type { FeedbackRecord } from "../repos/feedback.ts";
import type { FeedbackCaptureContext, FeedbackKind } from "../db/schema.ts";
import { captureDiff } from "./capture-diff.ts";
import type { OutgoingAttachment, OutgoingEmail } from "./sender.ts";

export const SUBJECT_PREFIX = "[Gigsy feedback]";
/** A capture-error report's prefix: an admin filtering their inbox can
 *  tell "the app read my flyer wrong" from everything else at a
 *  glance, and route it to whoever works on extraction. */
export const CAPTURE_ERROR_SUBJECT_PREFIX = "[Gigsy capture error]";

/** How much of the message the subject shows. Enough to tell two
 *  reports apart in an inbox list; the whole thing is in the body. */
export const SUBJECT_MESSAGE_CHARS = 60;

/**
 * `[Gigsy feedback] <first 60 chars of the message>`.
 *
 * Whitespace collapses to single spaces first: a message that starts
 * with a newline or a paragraph of its own must not put a line break
 * — or an empty subject — into a header. Exactly the first 60
 * characters after that, with no ellipsis: the design names the
 * subject that way, and the body carries the rest.
 */
export function feedbackSubject(
  message: string,
  kind: FeedbackKind = "general",
): string {
  const oneLine = message.replace(/\s+/g, " ").trim();
  const prefix = kind === "capture-error" ? CAPTURE_ERROR_SUBJECT_PREFIX : SUBJECT_PREFIX;
  return `${prefix} ${oneLine.slice(0, SUBJECT_MESSAGE_CHARS)}`;
}

/** "—" rather than an empty field: an admin scanning the body should
 *  see that nothing was reported, not wonder whether a line got cut. */
function orDash(value: string | null): string {
  return value === null || value === "" ? "—" : value;
}

const EMPTY_CONTEXT: FeedbackCaptureContext = {
  stage: null,
  draftId: null,
  source: null,
  originalKey: null,
  originalType: null,
  recognized: null,
  corrected: null,
  error: null,
};

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * The row's context_json, read back defensively. The route wrote it a
 * moment ago, but this builder is pure and takes any record: an
 * unreadable or missing context reads as all-absent (every line a
 * dash) rather than throwing, because a mail that cannot be built is a
 * report nobody sees.
 */
function captureContext(json: string | null): FeedbackCaptureContext {
  if (json === null) return EMPTY_CONTEXT;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return EMPTY_CONTEXT;
  }
  const o = objectOrNull(parsed);
  if (o === null) return EMPTY_CONTEXT;
  const source = o["source"];
  return {
    stage: stringOrNull(o["stage"]),
    draftId: stringOrNull(o["draftId"]),
    source: source === "photo" || source === "email" ? source : null,
    originalKey: stringOrNull(o["originalKey"]),
    originalType: stringOrNull(o["originalType"]),
    recognized: objectOrNull(o["recognized"]),
    corrected: objectOrNull(o["corrected"]),
    error: stringOrNull(o["error"]),
  };
}

/**
 * The capture-error lines between the header and the message.
 *
 * The error line appears only when there was one — on the review path
 * there never is, and "Error: —" would read as "something failed".
 * The diff block appears only when the client sent corrections: on the
 * extraction-failed path nothing was recognised and nothing corrected,
 * and an empty table would be noise. When corrections were sent and
 * none differs, the block says so, so "the user changed nothing" is
 * not mistaken for "the block got cut".
 */
function captureLines(context: FeedbackCaptureContext): string[] {
  const lines = [
    `Stage: ${orDash(context.stage)}`,
    `Draft: ${orDash(context.draftId)}`,
    `Source: ${orDash(context.source)}`,
    `Original: ${orDash(context.originalType)}`,
  ];
  if (context.error !== null && context.error !== "") lines.push(`Error: ${context.error}`);
  if (context.corrected !== null) {
    const diff = captureDiff(context.recognized, context.corrected);
    lines.push("", "Recognised → Corrected:");
    if (diff.length === 0) lines.push("  (no field differs)");
    for (const d of diff) lines.push(`  ${d.label}: ${d.recognized} → ${d.corrected}`);
  }
  return lines;
}

export function buildFeedbackMail(
  record: FeedbackRecord,
  images: OutgoingAttachment[],
  from: string,
  to: string[],
): OutgoingEmail {
  const capture = record.kind === "capture-error";
  const text = [
    `From: ${record.userEmail} (${record.userId})`,
    `When: ${new Date(record.createdAt).toISOString()}`,
    `Page: ${orDash(record.page)}`,
    `Version: ${orDash(record.clientVersion)}`,
    `Agent: ${orDash(record.userAgent)}`,
    // A capture-error report can attach an .eml, which is not an
    // image; `general` keeps the label it has always had.
    capture ? `Attachments: ${images.length}` : `Images: ${images.length}`,
    `Feedback id: ${record.id}`,
    ...(capture ? captureLines(captureContext(record.contextJson)) : []),
    "",
    record.message,
    "",
  ].join("\n");

  return {
    from,
    to,
    subject: feedbackSubject(record.message, record.kind),
    text,
    attachments: images.map((image) => ({
      filename: image.filename,
      type: image.type,
      content: image.content,
    })),
  };
}
