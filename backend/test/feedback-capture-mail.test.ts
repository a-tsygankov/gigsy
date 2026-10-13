import { describe, it, expect } from "vitest";
import {
  buildFeedbackMail,
  CAPTURE_ERROR_SUBJECT_PREFIX,
  feedbackSubject,
} from "../src/feedback/mail.ts";
import { captureDiff } from "../src/feedback/capture-diff.ts";
import type { FeedbackRecord } from "../src/repos/feedback.ts";
import type { FeedbackCaptureContext } from "../src/db/schema.ts";

/**
 * The capture-error mail (docs/superpowers/specs/2026-10-12-capture-
 * report-error-design.md): its own subject prefix, and a body that
 * shows an admin what extraction got wrong — one line per field the
 * user changed, nothing for the fields they left alone — so the report
 * can be read as a test case without opening the row.
 *
 * And the other half of the contract: a `general` row produces the mail
 * it always did, to the byte.
 */

const FROM = "feedback@example.com";
const TO = ["admin-a@example.com"];

const GENERAL: FeedbackRecord = {
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
  kind: "general",
  contextJson: null,
  createdAt: Date.UTC(2026, 9, 11, 14, 30, 0),
};

const FRI_8PM = Date.UTC(2026, 9, 16, 20, 0);
const SAT_8PM = Date.UTC(2026, 9, 17, 20, 0);

const CONTEXT: FeedbackCaptureContext = {
  stage: "review",
  draftId: "draft-9",
  source: "photo",
  originalKey: "u/user-1/feedback/fb-2/original",
  originalType: "image/jpeg",
  recognized: {
    kind: "gig",
    clientName: "Stub Co",
    location: "Town Hall",
    dateTimeMs: FRI_8PM,
    amountOfferedCents: 10000,
    notes: null,
  },
  corrected: {
    kind: "gig",
    clientName: "Stub Staffing Co",
    location: "Town Hall",
    dateTimes: [FRI_8PM],
    amountCents: 12500,
    category: null,
    notes: "",
  },
  error: null,
};

function captureRecord(context: FeedbackCaptureContext | null): FeedbackRecord {
  return {
    ...GENERAL,
    id: "fb-2",
    message: "Capture read 2 fields wrong: Client, Amount",
    kind: "capture-error",
    contextJson: context === null ? null : JSON.stringify(context),
  };
}

describe("general mail is unchanged", () => {
  it("is byte-for-byte the body the feedback design shipped", () => {
    const mail = buildFeedbackMail(GENERAL, [], FROM, TO);
    expect(mail.subject).toBe(
      "[Gigsy feedback] The dashboard tile says 3 to deliver but I have none.",
    );
    expect(mail.text).toBe(
      [
        "From: someone@example.com (user-1)",
        "When: 2026-10-11T14:30:00.000Z",
        "Page: /dashboard",
        "Version: 1.4.2",
        "Agent: Mozilla/5.0 (iPhone)",
        "Images: 0",
        "Feedback id: fb-1",
        "",
        "The dashboard tile says 3 to deliver but I have none.",
        "",
      ].join("\n"),
    );
  });

  it("ignores a context on a general row — kind decides the shape", () => {
    const withContext = { ...GENERAL, contextJson: JSON.stringify(CONTEXT) };
    expect(buildFeedbackMail(withContext, [], FROM, TO)).toEqual(
      buildFeedbackMail(GENERAL, [], FROM, TO),
    );
  });
});

describe("capture-error subject", () => {
  it("uses the capture-error prefix", () => {
    expect(CAPTURE_ERROR_SUBJECT_PREFIX).toBe("[Gigsy capture error]");
    expect(buildFeedbackMail(captureRecord(CONTEXT), [], FROM, TO).subject).toBe(
      "[Gigsy capture error] Capture read 2 fields wrong: Client, Amount",
    );
  });

  it("truncates and collapses whitespace exactly like the general subject", () => {
    const long = `\n${"b".repeat(70)}`;
    expect(feedbackSubject(long, "capture-error")).toBe(
      `[Gigsy capture error] ${"b".repeat(60)}`,
    );
    // The one-argument form is the general one, as before.
    expect(feedbackSubject("hi")).toBe("[Gigsy feedback] hi");
  });
});

describe("capture-error body", () => {
  it("lists only the fields that differ, recognised → corrected", () => {
    const { text } = buildFeedbackMail(captureRecord(CONTEXT), [], FROM, TO);
    expect(text).toContain("Recognised → Corrected:");
    expect(text).toContain('  Client: "Stub Co" → "Stub Staffing Co"');
    expect(text).toContain("  Amount: 100.00 → 125.00");
    // Same location, same date, null vs "" notes: not differences.
    expect(text).not.toContain("Location:");
    expect(text).not.toContain("Date:");
    expect(text).not.toContain("Notes:");
    expect(text).not.toContain("Kind:");
  });

  it("carries the stage, draft id, source and the original, then the message", () => {
    const { text } = buildFeedbackMail(
      captureRecord(CONTEXT),
      [{ filename: "original.jpeg", type: "image/jpeg", content: new ArrayBuffer(3) }],
      FROM,
      TO,
    );
    expect(text).toContain("From: someone@example.com (user-1)");
    expect(text).toContain("Stage: review");
    expect(text).toContain("Draft: draft-9");
    expect(text).toContain("Source: photo");
    expect(text).toContain("Original: image/jpeg");
    expect(text).toContain("Attachments: 1");
    expect(text).toContain("Feedback id: fb-2");
    expect(text).not.toContain("Error:");
    expect(text.trimEnd().endsWith("Capture read 2 fields wrong: Client, Amount")).toBe(true);
  });

  it("shows the error when there is one, and dashes for what is absent", () => {
    const failed: FeedbackCaptureContext = {
      stage: "extraction-failed",
      draftId: null,
      source: null,
      originalKey: null,
      originalType: null,
      recognized: null,
      corrected: null,
      error: "extraction failed — try again",
    };
    const { text } = buildFeedbackMail(captureRecord(failed), [], FROM, TO);
    expect(text).toContain("Stage: extraction-failed");
    expect(text).toContain("Draft: —");
    expect(text).toContain("Source: —");
    expect(text).toContain("Original: —");
    expect(text).toContain("Error: extraction failed — try again");
    // Nothing was recognised and nothing corrected: no diff block.
    expect(text).not.toContain("Recognised → Corrected");
  });

  it("says so when the user changed nothing", () => {
    const same: FeedbackCaptureContext = {
      ...CONTEXT,
      corrected: {
        kind: "gig",
        clientName: "Stub Co",
        location: "Town Hall",
        dateTimes: [FRI_8PM],
        amountCents: 10000,
        category: null,
        notes: null,
      },
    };
    const { text } = buildFeedbackMail(captureRecord(same), [], FROM, TO);
    expect(text).toContain("Recognised → Corrected:\n  (no field differs)");
  });

  it("does not throw on a capture-error row with no context", () => {
    const { text, subject } = buildFeedbackMail(captureRecord(null), [], FROM, TO);
    expect(subject.startsWith("[Gigsy capture error]")).toBe(true);
    expect(text).toContain("Stage: —");
  });
});

describe("captureDiff", () => {
  it("compares strings trimmed, with null, undefined and empty all meaning absent", () => {
    expect(
      captureDiff(
        { clientName: " Acme ", location: null, notes: undefined, category: "" },
        { clientName: "Acme", location: "", notes: null, category: null },
      ),
    ).toEqual([]);
  });

  it("is case-sensitive", () => {
    expect(captureDiff({ clientName: "acme" }, { clientName: "Acme" })).toEqual([
      { field: "clientName", label: "Client", recognized: '"acme"', corrected: '"Acme"' },
    ]);
  });

  it("reports a kind change", () => {
    expect(captureDiff({ kind: "gig" }, { kind: "expense" })).toEqual([
      { field: "kind", label: "Kind", recognized: '"gig"', corrected: '"expense"' },
    ]);
  });

  it("reads the amount the way DraftReview does: the offer for a gig, the total for an expense or payment", () => {
    // A gig shows what was offered; a stray total is not what the form held.
    expect(captureDiff({ kind: "gig", amountOfferedCents: 500, amountCents: 900 }, { kind: "gig", amountCents: 500 })).toEqual(
      [],
    );
    expect(captureDiff({ kind: "gig", amountCents: 900 }, { kind: "gig", amountCents: 900 })).toEqual([
      { field: "amount", label: "Amount", recognized: "—", corrected: "9.00" },
    ]);
    // An unsure reading is seeded as a gig, so it reads the offer too.
    expect(captureDiff({ kind: "unknown", amountOfferedCents: 700 }, { amountCents: 700 })).toEqual([
      { field: "kind", label: "Kind", recognized: '"unknown"', corrected: "—" },
    ]);
    expect(captureDiff({ kind: "expense", amountOfferedCents: 500, amountCents: 900 }, { amountCents: 950 })).toEqual(
      [
        { field: "kind", label: "Kind", recognized: '"expense"', corrected: "—" },
        { field: "amount", label: "Amount", recognized: "9.00", corrected: "9.50" },
      ],
    );
    expect(captureDiff({ kind: "payment", amountCents: 900 }, { kind: "payment", amountCents: 900 })).toEqual([]);
    expect(captureDiff({}, { amountCents: 12345 })).toEqual([
      { field: "amount", label: "Amount", recognized: "—", corrected: "123.45" },
    ]);
  });

  it("prefers dateTimesMs, falls back to [dateTimeMs] when the list is missing or empty, and prints ISO", () => {
    expect(
      captureDiff({ dateTimesMs: [FRI_8PM, SAT_8PM], dateTimeMs: FRI_8PM }, { dateTimes: [FRI_8PM, SAT_8PM] }),
    ).toEqual([]);
    // An empty list is how DraftReview falls back to the single date.
    expect(captureDiff({ dateTimesMs: [], dateTimeMs: FRI_8PM }, { dateTimes: [FRI_8PM] })).toEqual([]);
    expect(captureDiff({ dateTimeMs: FRI_8PM }, { dateTimes: [SAT_8PM] })).toEqual([
      {
        field: "dates",
        label: "Date",
        recognized: "2026-10-16T20:00:00.000Z",
        corrected: "2026-10-17T20:00:00.000Z",
      },
    ]);
    expect(captureDiff({ dateTimeMs: FRI_8PM }, { dateTimes: [FRI_8PM, SAT_8PM] })).toEqual([
      {
        field: "dates",
        label: "Date",
        recognized: "2026-10-16T20:00:00.000Z",
        corrected: "2026-10-16T20:00:00.000Z, 2026-10-17T20:00:00.000Z",
      },
    ]);
    expect(captureDiff({ dateTimeMs: null }, { dateTimes: [] })).toEqual([]);
  });

  it("compares dates to the minute, like the date box the user edited", () => {
    // Seconds the provider returned are nothing the user could change.
    expect(captureDiff({ dateTimeMs: FRI_8PM + 42_000 }, { dateTimes: [FRI_8PM] })).toEqual([]);
    expect(captureDiff({ dateTimeMs: FRI_8PM }, { dateTimes: [FRI_8PM + 60_000] })).toHaveLength(1);
  });

  it("lists fields in a fixed order — kind, client, location, date, amount, category, notes", () => {
    const fields = captureDiff(
      { notes: "a", category: "a", amountCents: 1, dateTimeMs: FRI_8PM, location: "a", clientName: "a", kind: "gig" },
      { notes: "b", category: "b", amountCents: 2, dateTimes: [SAT_8PM], location: "b", clientName: "b", kind: "expense" },
    ).map((d) => d.field);
    expect(fields).toEqual(["kind", "clientName", "location", "dates", "amount", "category", "notes"]);
  });

  it("treats a missing side as all-absent", () => {
    expect(captureDiff(null, { clientName: "Acme" })).toEqual([
      { field: "clientName", label: "Client", recognized: "—", corrected: '"Acme"' },
    ]);
    expect(captureDiff({ clientName: "Acme" }, null)).toEqual([]);
  });
});
