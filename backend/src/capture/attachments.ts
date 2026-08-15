/**
 * Which attachments are worth paying a model to look at.
 *
 * Every rule here exists to spend the extraction budget on the one
 * thing that is usually the actual booking — a flyer or a screenshot —
 * and not on the signature logo underneath it.
 *
 * Images only. PDFs would need a document block whose shape differs
 * between Gemini and Anthropic, which would push provider knowledge
 * back into the call site that providers.ts deliberately keeps clean.
 * They are named in `skipped` instead, so the user knows to open the
 * original.
 */
import { toBase64 } from "../lib/base64.ts";
import type { ExtractionMedia } from "./extraction.ts";

/** What both providers encode identically today. */
export const EXTRACTABLE_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

/** Below this, an image is decoration: a logo, a spacer, a pixel. */
export const MIN_ATTACHMENT_BYTES = 8 * 1024;

/** Above this, we decline to pay to look at it. */
export const MAX_ATTACHMENT_BYTES = 1_500_000;

/** How many images one email may spend on extraction. */
export const MAX_ATTACHMENTS = 2;

export interface CandidateAttachment {
  filename: string | null;
  mimeType: string;
  bytes: Uint8Array;
}

export interface AttachmentSelection {
  media: ExtractionMedia[];
  /** Phrases naming what went unread, for the draft note. Empty when
   * nothing was skipped that a user would care about. */
  skipped: string[];
}

/** postal-mime hands back one of three representations. */
export function attachmentBytes(part: {
  content: ArrayBuffer | Uint8Array | string;
  encoding?: "base64" | "utf8";
}): Uint8Array {
  const { content } = part;
  if (typeof content === "string") {
    return part.encoding === "base64"
      ? Uint8Array.from(atob(content), (ch) => ch.charCodeAt(0))
      : new TextEncoder().encode(content);
  }
  return content instanceof Uint8Array ? content : new Uint8Array(content);
}

export function selectAttachments(
  candidates: CandidateAttachment[],
): AttachmentSelection {
  const skipped: string[] = [];
  const usable: CandidateAttachment[] = [];

  for (const candidate of candidates) {
    const name = candidate.filename ?? "attachment";
    const mimeType = candidate.mimeType.toLowerCase();

    if (!EXTRACTABLE_IMAGE_TYPES.has(mimeType)) {
      skipped.push(`${name} (${mimeType})`);
      continue;
    }
    // Deliberately unnamed: a note listing four tracking pixels is
    // noise, and hides the PDF that matters.
    if (candidate.bytes.length < MIN_ATTACHMENT_BYTES) continue;
    if (candidate.bytes.length > MAX_ATTACHMENT_BYTES) {
      skipped.push(`${name} (too large to read)`);
      continue;
    }
    usable.push(candidate);
  }

  // Largest first: with room for only a couple, the biggest image is
  // the best available guess at which one is the actual document.
  usable.sort((a, b) => b.bytes.length - a.bytes.length);

  for (const extra of usable.slice(MAX_ATTACHMENTS)) {
    skipped.push(`${extra.filename ?? "attachment"} (not read)`);
  }

  return {
    media: usable.slice(0, MAX_ATTACHMENTS).map((candidate) => ({
      mimeType: candidate.mimeType.toLowerCase(),
      dataBase64: toBase64(candidate.bytes),
    })),
    skipped,
  };
}
