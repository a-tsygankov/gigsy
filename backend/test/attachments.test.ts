/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect } from "vitest";
import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  MIN_ATTACHMENT_BYTES,
  attachmentBytes,
  selectAttachments,
} from "../src/capture/attachments.ts";

function candidate(filename: string, mimeType: string, size: number) {
  return { filename, mimeType, bytes: new Uint8Array(size).fill(7) };
}

const BIG = MIN_ATTACHMENT_BYTES * 2;

describe("selectAttachments", () => {
  it("passes a real image through as media", () => {
    const result = selectAttachments([candidate("flyer.png", "image/png", BIG)]);
    expect(result.media).toHaveLength(1);
    expect(result.media[0]?.mimeType).toBe("image/png");
    expect(result.media[0]?.dataBase64.length).toBeGreaterThan(0);
    expect(result.skipped).toEqual([]);
  });

  it("names a PDF instead of reading it", () => {
    // PDFs need per-provider document blocks; until then the user must
    // be told the real document went unread.
    const result = selectAttachments([
      candidate("booking.pdf", "application/pdf", BIG),
    ]);
    expect(result.media).toHaveLength(0);
    expect(result.skipped.join(" ")).toContain("booking.pdf");
  });

  it("drops tiny images without mentioning them", () => {
    // Signature logos and tracking pixels. Naming every one would bury
    // the note that actually matters.
    const result = selectAttachments([
      candidate("logo.png", "image/png", MIN_ATTACHMENT_BYTES - 1),
    ]);
    expect(result.media).toHaveLength(0);
    expect(result.skipped).toEqual([]);
  });

  it("names an image too large to be worth reading", () => {
    const result = selectAttachments([
      candidate("huge.jpg", "image/jpeg", MAX_ATTACHMENT_BYTES + 1),
    ]);
    expect(result.media).toHaveLength(0);
    expect(result.skipped.join(" ")).toContain("huge.jpg");
  });

  it("keeps the largest images and names the rest", () => {
    const result = selectAttachments([
      candidate("small.png", "image/png", BIG),
      candidate("largest.png", "image/png", BIG * 4),
      candidate("middle.png", "image/png", BIG * 2),
    ]);
    expect(result.media).toHaveLength(MAX_ATTACHMENTS);
    expect(result.skipped.join(" ")).toContain("small.png");
    expect(result.skipped.join(" ")).not.toContain("largest.png");
  });

  it("normalises the mime type it reports", () => {
    const result = selectAttachments([candidate("f.png", "IMAGE/PNG", BIG)]);
    expect(result.media[0]?.mimeType).toBe("image/png");
  });

  it("survives an email with no attachments", () => {
    expect(selectAttachments([])).toEqual({ media: [], skipped: [] });
  });

  it("gives an unnamed attachment a placeholder name", () => {
    const result = selectAttachments([
      { filename: null, mimeType: "application/zip", bytes: new Uint8Array(BIG) },
    ]);
    expect(result.skipped.join(" ")).toContain("attachment");
  });
});

describe("attachmentBytes", () => {
  it("reads an ArrayBuffer part", () => {
    expect(
      attachmentBytes({ content: new Uint8Array([1, 2, 3]).buffer }),
    ).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("reads a Uint8Array part unchanged", () => {
    expect(attachmentBytes({ content: new Uint8Array([4, 5]) })).toEqual(
      new Uint8Array([4, 5]),
    );
  });

  it("decodes a base64 string part", () => {
    // Getting this wrong yields a byte length that passes the size
    // filters and an image the model cannot read.
    expect(attachmentBytes({ content: "aGVsbG8=", encoding: "base64" })).toEqual(
      new TextEncoder().encode("hello"),
    );
  });

  it("treats an unlabelled string part as utf8", () => {
    expect(attachmentBytes({ content: "hi" })).toEqual(
      new TextEncoder().encode("hi"),
    );
  });
});
