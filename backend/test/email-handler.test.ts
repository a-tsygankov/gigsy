/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeAll, vi } from "vitest";
import { env, createExecutionContext } from "cloudflare:test";
import worker from "../src/index.ts";
import { applyMigrations, seedUser } from "./helpers/db.ts";
import { DraftsRepo } from "../src/repos/drafts.ts";
import { handleCapturedEmail } from "../src/capture/email-capture.ts";
import type { ExtractionInput } from "../src/capture/extraction.ts";
import type { Bindings } from "../src/env.ts";

const U1 = "user-1";

function mimeEmail(to: string): Uint8Array {
  const raw = [
    "From: booker@agency.example",
    `To: ${to}`,
    "Subject: Tasting stand this Saturday",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Costco on 5th, $150 for the 6-hour shift. Confirm by Friday.",
    "",
  ].join("\r\n");
  return new TextEncoder().encode(raw);
}

function makeMessage(to: string) {
  const bytes = mimeEmail(to);
  return {
    from: "booker@agency.example",
    to,
    rawSize: bytes.length,
    raw: new Response(bytes).body!,
    headers: new Headers(),
    setReject: vi.fn(),
    forward: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
  };
}

beforeAll(async () => {
  await applyMigrations(env.DB);
  await seedUser(env.DB, U1);
});

describe("email() capture handler", () => {
  it("creates a pending draft for a known u-<userId> recipient", async () => {
    const message = makeMessage(`u-${U1}@gigs.example.com`);
    await worker.email!(message as never, env, createExecutionContext());

    expect(message.setReject).not.toHaveBeenCalled();
    const drafts = await DraftsRepo.for(env.DB).list(U1, "pending");
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.source).toBe("email");
    expect(drafts[0]?.rawR2Key).toContain(`u/${U1}/captures/`);
    const extracted = JSON.parse(drafts[0]!.extractedJson) as { kind: string };
    expect(extracted.kind).toBe("gig");

    // Raw email is retrievable for the review screen.
    const object = await env.RECEIPTS.get(drafts[0]!.rawR2Key!);
    expect(object).not.toBeNull();
    await object!.arrayBuffer();
  });

  it("rejects mail for unknown users without creating anything", async () => {
    const message = makeMessage("u-nobody-here@gigs.example.com");
    await worker.email!(message as never, env, createExecutionContext());

    expect(message.setReject).toHaveBeenCalled();
  });

  it("rejects addresses that are not u-<id> shaped", async () => {
    const message = makeMessage("info@gigs.example.com");
    await worker.email!(message as never, env, createExecutionContext());
    expect(message.setReject).toHaveBeenCalled();
  });
});

/** Wraps base64 at 76 columns the way a mail client does — some
 * parsers reject a single enormous line. */
function b64Body(text: string): string {
  return btoa(text).match(/.{1,76}/g)!.join("\r\n");
}

function htmlEmail(to: string): Uint8Array {
  return new TextEncoder().encode(
    [
      "From: booker@agency.example",
      `To: ${to}`,
      "Subject: Booking confirmed",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<html><body><style>.x{color:red}</style>" +
        "<p>Costco on 5th</p><p>$150 for the 6-hour shift</p></body></html>",
      "",
    ].join("\r\n"),
  );
}

/** One PNG attachment, comfortably over MIN_ATTACHMENT_BYTES. */
function imageEmail(to: string): Uint8Array {
  return new TextEncoder().encode(
    [
      "From: booker@agency.example",
      `To: ${to}`,
      "Subject: Flyer attached",
      'Content-Type: multipart/mixed; boundary="b1"',
      "",
      "--b1",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Flyer attached for Saturday.",
      "",
      "--b1",
      'Content-Type: image/png; name="flyer.png"',
      "Content-Transfer-Encoding: base64",
      'Content-Disposition: attachment; filename="flyer.png"',
      "",
      b64Body("\x89PNG\r\n\x1a\n" + "x".repeat(12000)),
      "",
      "--b1--",
      "",
    ].join("\r\n"),
  );
}

/** One PDF attachment — the case that must be named, not read. */
function pdfEmail(to: string): Uint8Array {
  return new TextEncoder().encode(
    [
      "From: booker@agency.example",
      `To: ${to}`,
      "Subject: Booking attached",
      'Content-Type: multipart/mixed; boundary="b1"',
      "",
      "--b1",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Details are in the attachment.",
      "",
      "--b1",
      'Content-Type: application/pdf; name="booking.pdf"',
      "Content-Transfer-Encoding: base64",
      'Content-Disposition: attachment; filename="booking.pdf"',
      "",
      b64Body("not really a pdf, but big enough".repeat(400)),
      "",
      "--b1--",
      "",
    ].join("\r\n"),
  );
}

function messageFrom(bytes: Uint8Array, to: string) {
  return {
    to,
    raw: new Response(bytes).body!,
    setReject: vi.fn(),
  };
}

/**
 * Records what extraction was actually asked to read.
 *
 * The whole point of these tests: the stub provider answers the same
 * thing whatever it is handed, so asserting on the resulting draft
 * cannot distinguish "read the HTML body" from "read nothing".
 */
function recordingProvider() {
  const seen: ExtractionInput[] = [];
  return {
    seen,
    factory: () => ({
      extract: async (input: ExtractionInput) => {
        seen.push(input);
        return { kind: "gig" as const, clientName: "Acme" };
      },
    }),
  };
}

describe("what the handler actually reads", () => {
  it("reads the body of an HTML-only email, not just the subject", async () => {
    // The common shape for a booking platform's confirmation. Before
    // this, extraction saw the subject line and nothing else.
    const to = `u-${U1}@gigs.example.com`;
    const recorder = recordingProvider();
    await handleCapturedEmail(
      messageFrom(htmlEmail(to), to),
      env as Bindings,
      recorder.factory,
    );

    expect(recorder.seen).toHaveLength(1);
    const text = recorder.seen[0]?.text ?? "";
    expect(text).toContain("Costco on 5th");
    expect(text).toContain("$150 for the 6-hour shift");
    // Never pay to send a stylesheet to a model as prose.
    expect(text).not.toContain("color:red");
  });

  it("sends an image attachment alongside the body", async () => {
    const to = `u-${U1}@gigs.example.com`;
    const recorder = recordingProvider();
    await handleCapturedEmail(
      messageFrom(imageEmail(to), to),
      env as Bindings,
      recorder.factory,
    );

    const input = recorder.seen[0];
    expect(input?.media ?? []).toHaveLength(1);
    expect(input?.media?.[0]?.mimeType).toBe("image/png");
    expect(input?.text ?? "").toContain("Flyer attached for Saturday");
  });

  it("names a PDF on the draft instead of reading it", async () => {
    const to = `u-${U1}@gigs.example.com`;
    const recorder = recordingProvider();
    await handleCapturedEmail(
      messageFrom(pdfEmail(to), to),
      env as Bindings,
      recorder.factory,
    );

    expect(recorder.seen[0]?.media ?? []).toHaveLength(0);

    // Any draft, not a positional one: other tests in this file have
    // already inserted drafts for this user and list order is not part
    // of the repo's contract.
    const drafts = await DraftsRepo.for(env.DB).list(U1, "pending");
    const named = drafts.some((draft) =>
      ((JSON.parse(draft.extractedJson) as { notes?: string }).notes ?? "").includes(
        "booking.pdf",
      ),
    );
    expect(named).toBe(true);
  });
});
