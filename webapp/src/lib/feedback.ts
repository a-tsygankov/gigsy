/**
 * What a feedback message may carry, decided on the device before any
 * byte leaves it (docs/superpowers/specs/2026-10-11-feedback-design.md).
 *
 * The server enforces the same numbers (backend/src/routes/feedback.ts:
 * message 1–4000 chars, ≤ 5 images, each `image/*` and ≤ 8 MB, ≤ 20 MB
 * together) and answers 400/413 when they are broken. These checks are
 * not a replacement for that — they exist so the refusal lands while
 * the picker is still in front of the person and they can pick again,
 * not after a 20 MB upload fails (the same argument Capture.tsx makes
 * for `MAX_IMAGE_BYTES`). Both sides must agree, which is why the
 * per-image ceiling is the queue's constant rather than a second 8.
 *
 * Pure functions, so the limits are tested without a DOM or a network
 * (lib/image-queue.ts's shape).
 */
import { MAX_IMAGE_BYTES } from "./image-queue.ts";

/** How many screenshots one message may carry. Enough to show a
 *  sequence; few enough that the mail stays readable. */
export const FEEDBACK_MAX_IMAGES = 5;

/** Ceiling on all images together. Five phone screenshots are well
 *  under this; five full-resolution photos are not, and that is the
 *  mis-tap this catches. */
export const FEEDBACK_MAX_TOTAL_BYTES = 20 * 1024 * 1024;

/** Longest message accepted. A bug report, not an essay. */
export const FEEDBACK_MAX_MESSAGE = 4000;

/** The success sentence. Fixed here so the tests assert the copy the
 *  design doc specifies, not a paraphrase. Shared by the help sheet's
 *  form (help/runtime/FeedbackForm.tsx) and the capture "Report error"
 *  sheet (components/CaptureReportSheet.tsx): one endpoint, one promise
 *  to the person, one wording of it. */
export const FEEDBACK_SENT_MESSAGE = "Thanks — it's on its way to the team.";
/** Appended when the server stored the message but could not mail it
 *  (`emailStatus` ≠ "sent"): nothing was lost, the delivery is just
 *  not instant. */
export const FEEDBACK_SAVED_MESSAGE = "Saved; the team will see it.";
/** The fallback when a failure carries no sentence of its own. */
export const FEEDBACK_FAILED_MESSAGE = "Couldn't send — try again.";
export const FEEDBACK_OFFLINE_MESSAGE =
  "Sending feedback needs a connection — it goes straight to the team.";

/** Derived from the constants so the number in the sentence can never
 *  drift from the number in the check (CAPTURE_TOO_LARGE_MESSAGE does
 *  the same). */
const perImageMb = Math.round(MAX_IMAGE_BYTES / (1024 * 1024));
const totalMb = Math.round(FEEDBACK_MAX_TOTAL_BYTES / (1024 * 1024));

export interface AddFeedbackImagesResult {
  /** `current` plus every chosen file that passed, in choice order. */
  images: File[];
  /** One human sentence per file that did not make it, naming the file
   *  so a person who picked five at once knows which one to drop. */
  refused: string[];
}

/**
 * Merge a fresh selection into the images already attached.
 *
 * Each file is judged on its own and in order: a non-image or an
 * oversize file is skipped WITHOUT stopping the files after it, while
 * the count and total ceilings are checked against what has been kept
 * so far — so picking six good screenshots keeps five and names the
 * sixth. `current` is never mutated; the caller swaps its state for
 * `images`.
 */
export function addFeedbackImages(
  current: File[],
  chosen: File[],
): AddFeedbackImagesResult {
  const images = [...current];
  const refused: string[] = [];
  let totalBytes = images.reduce((sum, file) => sum + file.size, 0);

  for (const file of chosen) {
    if (!file.type.startsWith("image/")) {
      refused.push(`${file.name} isn't an image.`);
      continue;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      refused.push(`${file.name} is too large — keep each image under ${perImageMb} MB.`);
      continue;
    }
    if (images.length >= FEEDBACK_MAX_IMAGES) {
      refused.push(
        `${file.name} wasn't added — up to ${FEEDBACK_MAX_IMAGES} images per message.`,
      );
      continue;
    }
    if (totalBytes + file.size > FEEDBACK_MAX_TOTAL_BYTES) {
      refused.push(
        `${file.name} wasn't added — all images together must stay under ${totalMb} MB.`,
      );
      continue;
    }
    images.push(file);
    totalBytes += file.size;
  }

  return { images, refused };
}

/**
 * What stops Send, or null when nothing does.
 *
 * The message is the only required part; images are optional. The
 * image caps are re-checked here even though `addFeedbackImages` is
 * the gate, so a list assembled any other way can never go out in a
 * shape the server would refuse. One reason at a time — the first that
 * applies — because the form shows it as a single line.
 */
export function feedbackProblem(message: string, images: File[]): string | null {
  if (message.trim() === "") return "Write what happened first.";
  if (message.length > FEEDBACK_MAX_MESSAGE) {
    return `Keep the message under ${FEEDBACK_MAX_MESSAGE} characters.`;
  }
  if (images.length > FEEDBACK_MAX_IMAGES) {
    return `Up to ${FEEDBACK_MAX_IMAGES} images per message.`;
  }
  const totalBytes = images.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > FEEDBACK_MAX_TOTAL_BYTES) {
    return `All images together must stay under ${totalMb} MB.`;
  }
  return null;
}
