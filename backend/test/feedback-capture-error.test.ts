/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import { applyMigrations, seedUser } from "./helpers/db.ts";
import { issueAccessToken } from "../src/auth/tokens.ts";
import {
  MAX_CORRECTED_BYTES,
  feedbackOriginalKey,
  makeFeedbackRouter,
} from "../src/routes/feedback.ts";
import { DraftsRepo } from "../src/repos/drafts.ts";
import type { EmailSender, OutgoingEmail } from "../src/feedback/sender.ts";
import type { DraftSource } from "../src/db/schema.ts";
import type { ExtractedDataT } from "../src/capture/extraction.ts";
import type { Bindings } from "../src/env.ts";

/**
 * POST /api/feedback with kind = capture-error — capture's "Report
 * error" (docs/superpowers/specs/2026-10-12-capture-report-error-
 * design.md), on top of the feedback route test/feedback.test.ts pins.
 *
 * What these add to that file's contract: the server, not the client,
 * is the source of what was RECOGNISED (read from the caller's own
 * draft row) and of the ORIGINAL (copied server-side from the draft's
 * R2 object, never re-uploaded); a draft that is not the caller's is a
 * 404 that stores nothing; and every new part is validated before
 * anything is stored, exactly like the parts that were already there.
 */

const U1 = "capture-report-user-1";
const U1_EMAIL = "capture-report-user-1@example.com";
const U2 = "capture-report-user-2";

const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 5, 6]);
const EML = new TextEncoder().encode(
  "From: agency@example.com\r\nSubject: Booking\r\n\r\nFriday 8pm, $125.\r\n",
);

/** What the stub-ish extraction "read" off the flyer: the client name
 *  is wrong, the amount is wrong, the location is right. */
const RECOGNIZED: ExtractedDataT = {
  kind: "gig",
  clientName: "Stub Co",
  location: "Town Hall",
  dateTimeMs: Date.UTC(2026, 9, 16, 20, 0),
  amountOfferedCents: 10000,
  notes: null,
};

/** What the user corrected it to on the review screen. */
const CORRECTED = {
  kind: "gig",
  clientName: "Stub Staffing Co",
  location: "Town Hall",
  dateTimes: [Date.UTC(2026, 9, 16, 20, 0)],
  amountCents: 12500,
  category: null,
  notes: null,
};

type FeedbackWire = { id: string; emailStatus: string };

type FeedbackRow = {
  id: string;
  user_id: string;
  message: string;
  kind: string;
  context_json: string | null;
  images_json: string;
  email_status: string;
};

type Context = {
  stage: string | null;
  draftId: string | null;
  source: string | null;
  originalKey: string | null;
  originalType: string | null;
  recognized: Record<string, unknown> | null;
  corrected: Record<string, unknown> | null;
  error: string | null;
};

function recorder(): EmailSender & { sent: OutgoingEmail[] } {
  const sent: OutgoingEmail[] = [];
  return {
    sent,
    send: async (m) => {
      sent.push(m);
      return { messageId: "m1" };
    },
  };
}

function appWith(sender: EmailSender | null): Hono {
  return new Hono().route("/api/feedback", makeFeedbackRouter(() => sender));
}

/**
 * A pending draft with its raw object in R2, the way
 * capture/capture-service.ts leaves one — inserted directly so the
 * test controls exactly what was "recognised" and what type the
 * original is. `rawBytes: null` stands in for an original that went
 * missing from R2 after the draft was written.
 */
async function seedDraft(
  userId: string,
  source: DraftSource,
  rawBytes: Uint8Array | null,
  contentType: string,
  extracted: ExtractedDataT = RECOGNIZED,
): Promise<string> {
  const id = crypto.randomUUID();
  const rawR2Key = `u/${userId}/captures/${id}`;
  if (rawBytes !== null) {
    await env.RECEIPTS.put(rawR2Key, rawBytes, { httpMetadata: { contentType } });
  }
  await DraftsRepo.for(env.DB).insert(userId, {
    id,
    source,
    rawR2Key,
    extractedJson: JSON.stringify(extracted),
    now: Date.now(),
  });
  return id;
}

function form(
  parts: Record<string, string>,
  images: { bytes: Uint8Array; name: string; type: string }[] = [],
): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(parts)) fd.set(k, v);
  for (const img of images) {
    fd.append("image", new File([img.bytes], img.name, { type: img.type }));
  }
  return fd;
}

function reportForm(draftId: string, extra: Record<string, string> = {}): FormData {
  return form({
    message: "Capture read 2 fields wrong: Client, Amount",
    kind: "capture-error",
    draftId,
    corrected: JSON.stringify(CORRECTED),
    stage: "review",
    ...extra,
  });
}

async function post(app: Hono, body: FormData, userId = U1): Promise<Response> {
  const token = await issueAccessToken({ userId, secret: env.AUTH_SECRET, ttlSeconds: 900 });
  return app.request(
    "/api/feedback",
    { method: "POST", headers: { Authorization: `Bearer ${token}` }, body },
    env as unknown as Bindings,
  );
}

async function rowFor(id: string): Promise<FeedbackRow | null> {
  return env.DB.prepare("SELECT * FROM feedback WHERE id = ?").bind(id).first<FeedbackRow>();
}

async function rowCount(): Promise<number> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM feedback").first<{ n: number }>();
  return r?.n ?? 0;
}

async function feedbackKeys(): Promise<string[]> {
  const keys: string[] = [];
  for (const user of [U1, U2]) {
    const listed = await env.RECEIPTS.list({ prefix: `u/${user}/feedback/` });
    keys.push(...listed.objects.map((o) => o.key));
  }
  return keys;
}

beforeAll(async () => {
  await applyMigrations(env.DB);
  await seedUser(env.DB, U1, U1_EMAIL);
  await seedUser(env.DB, U2);
});

describe("capture-error from a photo draft", () => {
  it("stores kind and context: recognised from the server's draft, corrected from the client", async () => {
    const draftId = await seedDraft(U1, "photo", JPG, "image/jpeg");
    // A client-sent `recognized` part is ignored: the server reads
    // what was recognised from the draft row, not from the phone.
    const body = reportForm(draftId, { recognized: JSON.stringify({ kind: "expense" }) });
    const res = await post(appWith(recorder()), body);
    expect(res.status).toBe(200);
    const wire = (await res.json()) as FeedbackWire;

    const row = await rowFor(wire.id);
    expect(row!.kind).toBe("capture-error");
    expect(row!.message).toBe("Capture read 2 fields wrong: Client, Amount");
    const context = JSON.parse(row!.context_json!) as Context;
    expect(context).toEqual({
      stage: "review",
      draftId,
      source: "photo",
      originalKey: feedbackOriginalKey(U1, wire.id),
      originalType: "image/jpeg",
      recognized: RECOGNIZED,
      corrected: CORRECTED,
      error: null,
    });
  });

  it("copies the original to the feedback key and lists it as an image", async () => {
    const draftId = await seedDraft(U1, "photo", JPG, "image/jpeg");
    const res = await post(appWith(recorder()), reportForm(draftId));
    const wire = (await res.json()) as FeedbackWire;

    const key = feedbackOriginalKey(U1, wire.id);
    expect(key).toBe(`u/${U1}/feedback/${wire.id}/original`);
    const copied = await env.RECEIPTS.get(key);
    expect(new Uint8Array(await copied!.arrayBuffer())).toEqual(JPG);
    expect(copied!.httpMetadata?.contentType).toBe("image/jpeg");

    // A copy, not a move: the draft keeps its own original.
    expect(await env.RECEIPTS.head(`u/${U1}/captures/${draftId}`)).not.toBeNull();

    const images = JSON.parse((await rowFor(wire.id))!.images_json) as unknown[];
    expect(images).toEqual([
      { key, type: "image/jpeg", size: JPG.length, name: "original.jpeg" },
    ]);
  });

  it("mails the original as an attachment after any user images, with the diff in the body", async () => {
    const sender = recorder();
    const draftId = await seedDraft(U1, "photo", JPG, "image/jpeg");
    const body = reportForm(draftId);
    body.append("image", new File([PNG], "screen.png", { type: "image/png" }));
    const res = await post(appWith(sender), body);
    const wire = (await res.json()) as FeedbackWire;
    expect(wire.emailStatus).toBe("sent");

    expect(sender.sent).toHaveLength(1);
    const mail = sender.sent[0]!;
    expect(mail.subject).toBe("[Gigsy capture error] Capture read 2 fields wrong: Client, Amount");
    expect(mail.attachments.map((a) => [a.filename, a.type])).toEqual([
      ["screen.png", "image/png"],
      ["original.jpeg", "image/jpeg"],
    ]);
    expect(new Uint8Array(mail.attachments[1]!.content)).toEqual(JPG);

    expect(mail.text).toContain("Recognised → Corrected");
    expect(mail.text).toContain('Client: "Stub Co" → "Stub Staffing Co"');
    expect(mail.text).toContain("Amount: 100.00 → 125.00");
    // Unchanged fields are not listed.
    expect(mail.text).not.toContain("Location:");
    expect(mail.text).toContain(`Draft: ${draftId}`);
    expect(mail.text).toContain("Source: photo");
    expect(mail.text).toContain("Stage: review");

    // The user image keeps its numbered key; the original has its own.
    const images = JSON.parse((await rowFor(wire.id))!.images_json) as { key: string }[];
    expect(images.map((i) => i.key)).toEqual([
      `u/${U1}/feedback/${wire.id}/0`,
      `u/${U1}/feedback/${wire.id}/original`,
    ]);
  });
});

describe("capture-error from an email draft", () => {
  it("copies the .eml but does not list it as an image", async () => {
    const draftId = await seedDraft(U1, "email", EML, "message/rfc822");
    const res = await post(appWith(recorder()), reportForm(draftId));
    expect(res.status).toBe(200);
    const wire = (await res.json()) as FeedbackWire;

    const key = feedbackOriginalKey(U1, wire.id);
    const copied = await env.RECEIPTS.get(key);
    expect(new Uint8Array(await copied!.arrayBuffer())).toEqual(EML);
    expect(copied!.httpMetadata?.contentType).toBe("message/rfc822");

    const row = await rowFor(wire.id);
    expect(JSON.parse(row!.images_json)).toEqual([]);
    const context = JSON.parse(row!.context_json!) as Context;
    expect(context.source).toBe("email");
    expect(context.originalKey).toBe(key);
    expect(context.originalType).toBe("message/rfc822");
  });

  it("still attaches the .eml to the mail", async () => {
    const sender = recorder();
    const draftId = await seedDraft(U1, "email", EML, "message/rfc822");
    await post(appWith(sender), reportForm(draftId));

    const mail = sender.sent[0]!;
    expect(mail.attachments.map((a) => [a.filename, a.type])).toEqual([
      ["original.eml", "message/rfc822"],
    ]);
    expect(new Uint8Array(mail.attachments[0]!.content)).toEqual(EML);
    expect(mail.text).toContain("Source: email");
  });
});

describe("capture-error without an original", () => {
  it("extraction failed: no draft, the chosen file as an image part, the error in the context", async () => {
    const sender = recorder();
    const res = await post(
      appWith(sender),
      form(
        {
          message: "Capture could not read this.",
          kind: "capture-error",
          stage: "extraction-failed",
          error: "extraction failed — try again",
        },
        [{ bytes: JPG, name: "flyer.jpg", type: "image/jpeg" }],
      ),
    );
    expect(res.status).toBe(200);
    const wire = (await res.json()) as FeedbackWire;

    const row = await rowFor(wire.id);
    expect(row!.kind).toBe("capture-error");
    expect(JSON.parse(row!.context_json!)).toEqual({
      stage: "extraction-failed",
      draftId: null,
      source: null,
      originalKey: null,
      originalType: null,
      recognized: null,
      corrected: null,
      error: "extraction failed — try again",
    });
    expect((JSON.parse(row!.images_json) as { key: string }[]).map((i) => i.key)).toEqual([
      `u/${U1}/feedback/${wire.id}/0`,
    ]);

    const mail = sender.sent[0]!;
    expect(mail.subject).toBe("[Gigsy capture error] Capture could not read this.");
    expect(mail.text).toContain("Error: extraction failed — try again");
    expect(mail.attachments.map((a) => a.filename)).toEqual(["flyer.jpg"]);
  });

  it("a draft whose raw object is gone is still reported, with no original", async () => {
    const sender = recorder();
    const draftId = await seedDraft(U1, "photo", null, "image/jpeg");
    const res = await post(appWith(sender), reportForm(draftId));
    expect(res.status).toBe(200);
    const wire = (await res.json()) as FeedbackWire;

    const context = JSON.parse((await rowFor(wire.id))!.context_json!) as Context;
    expect(context.draftId).toBe(draftId);
    expect(context.recognized).toEqual(RECOGNIZED);
    expect(context.originalKey).toBeNull();
    expect(context.originalType).toBeNull();
    expect(await env.RECEIPTS.head(feedbackOriginalKey(U1, wire.id))).toBeNull();
    expect(sender.sent[0]!.attachments).toEqual([]);
  });
});

describe("capture-error refusals store nothing", () => {
  async function expectNothingStored(
    body: FormData,
    status: number,
    userId = U1,
  ): Promise<{ error: string }> {
    const sender = recorder();
    const rowsBefore = await rowCount();
    const keysBefore = await feedbackKeys();

    const res = await post(appWith(sender), body, userId);
    expect(res.status).toBe(status);

    expect(await rowCount()).toBe(rowsBefore);
    expect(await feedbackKeys()).toEqual(keysBefore);
    expect(sender.sent).toHaveLength(0);
    return (await res.json()) as { error: string };
  }

  it("404s another user's draft", async () => {
    const theirs = await seedDraft(U2, "photo", JPG, "image/jpeg");
    const body = await expectNothingStored(reportForm(theirs), 404);
    expect(body).toEqual({ error: "draft not found" });
    // And their original was not copied anywhere under the caller.
    expect(await env.RECEIPTS.head(`u/${U2}/captures/${theirs}`)).not.toBeNull();
  });

  it("404s a draft id that does not exist", async () => {
    const body = await expectNothingStored(reportForm(crypto.randomUUID()), 404);
    expect(body).toEqual({ error: "draft not found" });
  });

  it("400s `corrected` that is not JSON", async () => {
    const draftId = await seedDraft(U1, "photo", JPG, "image/jpeg");
    const body = await expectNothingStored(reportForm(draftId, { corrected: "{not json" }), 400);
    expect(body.error).toMatch(/corrected/);
  });

  it("400s `corrected` that parses to something other than an object", async () => {
    const draftId = await seedDraft(U1, "photo", JPG, "image/jpeg");
    await expectNothingStored(reportForm(draftId, { corrected: "[1,2]" }), 400);
    await expectNothingStored(reportForm(draftId, { corrected: "null" }), 400);
    await expectNothingStored(reportForm(draftId, { corrected: "42" }), 400);
  });

  it("400s `corrected` over 16 KB", async () => {
    const draftId = await seedDraft(U1, "photo", JPG, "image/jpeg");
    const big = JSON.stringify({ notes: "x".repeat(MAX_CORRECTED_BYTES) });
    const body = await expectNothingStored(reportForm(draftId, { corrected: big }), 400);
    expect(body.error).toMatch(/corrected/);
  });

  it("400s an unknown kind", async () => {
    const body = await expectNothingStored(
      form({ message: "what kind is this", kind: "bug-report" }),
      400,
    );
    expect(body.error).toMatch(/kind/);
  });

  for (const part of ["draftId", "corrected", "stage", "error"] as const) {
    it(`400s \`${part}\` on a general submission`, async () => {
      const draftId = await seedDraft(U1, "photo", JPG, "image/jpeg");
      const values: Record<typeof part, string> = {
        draftId,
        corrected: JSON.stringify(CORRECTED),
        stage: "review",
        error: "boom",
      };
      // Both spellings of general: omitted, and named.
      const body = await expectNothingStored(
        form({ message: "general with a capture part", [part]: values[part] }),
        400,
      );
      expect(body.error).toMatch(new RegExp(part));
      await expectNothingStored(
        form({ message: "general with a capture part", kind: "general", [part]: values[part] }),
        400,
      );
    });
  }

  it("validates the draft only after the message: an empty message is 400, not 404", async () => {
    await expectNothingStored(
      form({ message: "  ", kind: "capture-error", draftId: crypto.randomUUID() }),
      400,
    );
  });
});

describe("general is unchanged", () => {
  it("no kind part → kind general, null context, the old subject", async () => {
    const sender = recorder();
    const res = await post(appWith(sender), form({ message: "plain feedback" }));
    expect(res.status).toBe(200);
    const wire = (await res.json()) as FeedbackWire;
    const row = await rowFor(wire.id);
    expect(row!.kind).toBe("general");
    expect(row!.context_json).toBeNull();
    expect(sender.sent[0]!.subject).toBe("[Gigsy feedback] plain feedback");
  });

  it("kind=general is accepted and means the same", async () => {
    const res = await post(appWith(recorder()), form({ message: "named", kind: "general" }));
    expect(res.status).toBe(200);
    const row = await rowFor(((await res.json()) as FeedbackWire).id);
    expect(row!.kind).toBe("general");
    expect(row!.context_json).toBeNull();
  });
});
