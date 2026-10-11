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
 */
import type { FeedbackRecord } from "../repos/feedback.ts";
import type { OutgoingAttachment, OutgoingEmail } from "./sender.ts";

export const SUBJECT_PREFIX = "[Gigsy feedback]";

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
export function feedbackSubject(message: string): string {
  const oneLine = message.replace(/\s+/g, " ").trim();
  return `${SUBJECT_PREFIX} ${oneLine.slice(0, SUBJECT_MESSAGE_CHARS)}`;
}

/** "—" rather than an empty field: an admin scanning the body should
 *  see that nothing was reported, not wonder whether a line got cut. */
function orDash(value: string | null): string {
  return value === null || value === "" ? "—" : value;
}

export function buildFeedbackMail(
  record: FeedbackRecord,
  images: OutgoingAttachment[],
  from: string,
  to: string[],
): OutgoingEmail {
  const text = [
    `From: ${record.userEmail} (${record.userId})`,
    `When: ${new Date(record.createdAt).toISOString()}`,
    `Page: ${orDash(record.page)}`,
    `Version: ${orDash(record.clientVersion)}`,
    `Agent: ${orDash(record.userAgent)}`,
    `Images: ${images.length}`,
    `Feedback id: ${record.id}`,
    "",
    record.message,
    "",
  ].join("\n");

  return {
    from,
    to,
    subject: feedbackSubject(record.message),
    text,
    attachments: images.map((image) => ({
      filename: image.filename,
      type: image.type,
      content: image.content,
    })),
  };
}
