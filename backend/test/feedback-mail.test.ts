import { describe, it, expect } from "vitest";
import {
  buildFeedbackMail,
  feedbackSubject,
  SUBJECT_MESSAGE_CHARS,
} from "../src/feedback/mail.ts";
import type { FeedbackRecord } from "../src/repos/feedback.ts";

/**
 * The mail is the admin UI (docs/superpowers/specs/2026-10-11-
 * feedback-design.md), so what it says is behaviour, not formatting.
 * Pure function, no sender: a record and bytes in, a message out.
 */

const RECORD: FeedbackRecord = {
  id: "fb-1",
  userId: "user-1",
  userEmail: "someone@example.com",
  message: "The dashboard tile says 3 to deliver but I have none.",
  page: "/dashboard",
  clientVersion: "1.4.2",
  userAgent: "Mozilla/5.0 (iPhone)",
  imagesJson: "[]",
  emailStatus: "unsent",
  emailError: null,
  createdAt: Date.UTC(2026, 9, 11, 14, 30, 0),
};

const FROM = "feedback@example.com";
const TO = ["admin-a@example.com", "admin-b@example.com"];

describe("feedbackSubject", () => {
  it("prefixes and keeps a short message whole", () => {
    expect(feedbackSubject("Button does nothing")).toBe(
      "[Gigsy feedback] Button does nothing",
    );
  });

  it("truncates to the first 60 characters of the message", () => {
    const long = "a".repeat(SUBJECT_MESSAGE_CHARS) + "TAIL";
    expect(feedbackSubject(long)).toBe(`[Gigsy feedback] ${"a".repeat(60)}`);
    expect(feedbackSubject(long)).not.toContain("TAIL");
  });

  it("collapses line breaks and runs of whitespace — a header is one line", () => {
    expect(feedbackSubject("\n\nFirst   line\nsecond line  ")).toBe(
      "[Gigsy feedback] First line second line",
    );
  });
});

describe("buildFeedbackMail", () => {
  it("addresses every admin from the configured sender", () => {
    const mail = buildFeedbackMail(RECORD, [], FROM, TO);
    expect(mail.from).toBe(FROM);
    expect(mail.to).toEqual(TO);
  });

  it("puts the subject on the message", () => {
    expect(buildFeedbackMail(RECORD, [], FROM, TO).subject).toBe(
      "[Gigsy feedback] The dashboard tile says 3 to deliver but I have none.",
    );
  });

  it("body says who, when, page, version, agent and the message", () => {
    const { text } = buildFeedbackMail(RECORD, [], FROM, TO);
    expect(text).toContain("someone@example.com");
    expect(text).toContain("user-1");
    expect(text).toContain("2026-10-11T14:30:00.000Z");
    expect(text).toContain("Page: /dashboard");
    expect(text).toContain("Version: 1.4.2");
    expect(text).toContain("Agent: Mozilla/5.0 (iPhone)");
    expect(text).toContain("Feedback id: fb-1");
    expect(text).toContain(RECORD.message);
  });

  it("shows a dash for context the client did not report", () => {
    const { text } = buildFeedbackMail(
      { ...RECORD, page: null, clientVersion: null, userAgent: "" },
      [],
      FROM,
      TO,
    );
    expect(text).toContain("Page: —");
    expect(text).toContain("Version: —");
    expect(text).toContain("Agent: —");
  });

  it("attaches one file per image with its filename and type, bytes intact", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer;
    const jpg = new Uint8Array([0xff, 0xd8, 0xff]).buffer;
    const mail = buildFeedbackMail(
      RECORD,
      [
        { filename: "shot-1.png", type: "image/png", content: png },
        { filename: "shot-2.jpg", type: "image/jpeg", content: jpg },
      ],
      FROM,
      TO,
    );
    expect(mail.attachments).toHaveLength(2);
    expect(mail.attachments.map((a) => [a.filename, a.type])).toEqual([
      ["shot-1.png", "image/png"],
      ["shot-2.jpg", "image/jpeg"],
    ]);
    expect(mail.attachments[0]!.content).toBe(png);
    expect(mail.attachments[1]!.content).toBe(jpg);
    expect(mail.text).toContain("Images: 2");
  });

  it("has no attachments when there were no images", () => {
    const mail = buildFeedbackMail(RECORD, [], FROM, TO);
    expect(mail.attachments).toEqual([]);
    expect(mail.text).toContain("Images: 0");
  });
});
