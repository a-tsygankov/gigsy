/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeAll } from "vitest";
import { SELF, env } from "cloudflare:test";
import { Hono } from "hono";
import { applyMigrations, seedUser } from "./helpers/db.ts";
import { issueAccessToken } from "../src/auth/tokens.ts";
import {
  FEEDBACK_DAILY_CAP,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_IMAGE_BYTES,
  makeFeedbackRouter,
} from "../src/routes/feedback.ts";
import { FeedbackRepo } from "../src/repos/feedback.ts";
import type { EmailSender, OutgoingEmail } from "../src/feedback/sender.ts";
import type { Bindings } from "../src/env.ts";

/**
 * POST /api/feedback (docs/superpowers/specs/2026-10-11-feedback-design.md).
 *
 * The sender is injected throughout, so these tests never touch a
 * `send_email` binding — there is none in the test runtime, exactly as
 * in a deployment that has not turned Email Sending on. What they pin
 * is the ORDER the route works in: validate first (a refusal stores
 * nothing), then store, then mail — so every configuration gap or
 * sender failure still leaves the row and the images behind.
 */

const U1 = "feedback-user-1";
const U1_EMAIL = "feedback-user-1@example.com";
const ADMINS = ["admin-a@example.com", "admin-b@example.com"];

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 7, 8, 9, 10, 11]);

type FeedbackWire = { id: string; emailStatus: string };

type FeedbackRow = {
  id: string;
  user_id: string;
  user_email: string;
  message: string;
  page: string | null;
  client_version: string | null;
  user_agent: string | null;
  images_json: string;
  email_status: string;
  email_error: string | null;
  created_at: number;
};

/** A sender that remembers what it was asked to send. */
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

function form(
  message: string,
  images: { bytes: Uint8Array; name: string; type: string }[] = [],
  extra: Record<string, string> = {},
): FormData {
  const fd = new FormData();
  fd.set("message", message);
  for (const [k, v] of Object.entries(extra)) fd.set(k, v);
  for (const img of images) {
    fd.append("image", new File([img.bytes], img.name, { type: img.type }));
  }
  return fd;
}

async function post(
  app: Hono,
  body: FormData,
  options: { userId?: string; envOverrides?: Partial<Bindings>; headers?: Record<string, string> } = {},
): Promise<Response> {
  const token = await issueAccessToken({
    userId: options.userId ?? U1,
    secret: env.AUTH_SECRET,
    ttlSeconds: 900,
  });
  return app.request(
    "/api/feedback",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, ...(options.headers ?? {}) },
      body,
    },
    { ...env, ...(options.envOverrides ?? {}) } as Bindings,
  );
}

async function rowFor(id: string): Promise<FeedbackRow | null> {
  return env.DB.prepare("SELECT * FROM feedback WHERE id = ?")
    .bind(id)
    .first<FeedbackRow>();
}

async function rowCount(): Promise<number> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM feedback").first<{ n: number }>();
  return r?.n ?? 0;
}

async function imageKeysFor(userId: string): Promise<string[]> {
  const listed = await env.RECEIPTS.list({ prefix: `u/${userId}/feedback/` });
  return listed.objects.map((o) => o.key);
}

beforeAll(async () => {
  await applyMigrations(env.DB);
  await seedUser(env.DB, U1, U1_EMAIL);
});

describe("POST /api/feedback — the happy path", () => {
  it("stores the row and the images, mails every admin with attachments, records sent", async () => {
    const sender = recorder();
    const res = await post(
      appWith(sender),
      form(
        "  The calendar tile is blank after a sync.  ",
        [
          { bytes: PNG, name: "shot-1.png", type: "image/png" },
          { bytes: JPG, name: "shot-2.jpg", type: "image/jpeg" },
        ],
        { page: "/calendar", clientVersion: "1.2.3" },
      ),
      { headers: { "user-agent": "GigsyTest/1.0" } },
    );
    expect(res.status).toBe(200);
    const wire = (await res.json()) as FeedbackWire;
    expect(wire.emailStatus).toBe("sent");

    // The row: who, what, where, and the context the user never typed.
    const row = await rowFor(wire.id);
    expect(row).not.toBeNull();
    expect(row!.user_id).toBe(U1);
    expect(row!.user_email).toBe(U1_EMAIL);
    expect(row!.message).toBe("The calendar tile is blank after a sync.");
    expect(row!.page).toBe("/calendar");
    expect(row!.client_version).toBe("1.2.3");
    expect(row!.user_agent).toBe("GigsyTest/1.0");
    expect(row!.email_status).toBe("sent");
    expect(row!.email_error).toBeNull();

    // The images: one R2 object each, under the user's own prefix,
    // listed on the row in the order they were sent.
    const images = JSON.parse(row!.images_json) as {
      key: string;
      type: string;
      size: number;
      name: string;
    }[];
    expect(images).toEqual([
      { key: `u/${U1}/feedback/${wire.id}/0`, type: "image/png", size: PNG.length, name: "shot-1.png" },
      { key: `u/${U1}/feedback/${wire.id}/1`, type: "image/jpeg", size: JPG.length, name: "shot-2.jpg" },
    ]);
    const stored0 = await env.RECEIPTS.get(images[0]!.key);
    expect(new Uint8Array(await stored0!.arrayBuffer())).toEqual(PNG);
    expect(stored0!.httpMetadata?.contentType).toBe("image/png");
    const stored1 = await env.RECEIPTS.get(images[1]!.key);
    expect(new Uint8Array(await stored1!.arrayBuffer())).toEqual(JPG);

    // The mail: one message, every admin, both images attached.
    expect(sender.sent).toHaveLength(1);
    const mail = sender.sent[0]!;
    expect(mail.from).toBe("feedback@example.com");
    expect(mail.to).toEqual(ADMINS);
    expect(mail.subject).toBe("[Gigsy feedback] The calendar tile is blank after a sync.");
    expect(mail.text).toContain(U1_EMAIL);
    expect(mail.text).toContain("The calendar tile is blank after a sync.");
    expect(mail.attachments.map((a) => [a.filename, a.type])).toEqual([
      ["shot-1.png", "image/png"],
      ["shot-2.jpg", "image/jpeg"],
    ]);
    expect(new Uint8Array(mail.attachments[0]!.content)).toEqual(PNG);
  });

  it("stores the R2 objects under the sending user's own prefix — there is no read route", async () => {
    // The key is the tenancy boundary in R2 the way user_id is in D1.
    // No route serves these objects back (not even to their owner):
    // the mail is the only thing that carries the bytes anywhere, so
    // the assertion is that the key names the user, nothing more.
    const res = await post(
      appWith(recorder()),
      form("one image", [{ bytes: PNG, name: "a.png", type: "image/png" }]),
    );
    const wire = (await res.json()) as FeedbackWire;
    const row = await rowFor(wire.id);
    const images = JSON.parse(row!.images_json) as { key: string }[];
    expect(images[0]!.key.startsWith(`u/${U1}/feedback/${wire.id}/`)).toBe(true);
    expect(images[0]!.key).not.toContain("user-2");

    const res2 = await SELF.fetch(`https://localhost/api/feedback/${wire.id}/0`);
    expect(res2.status).toBe(401);
  });

  it("accepts a message with no images", async () => {
    const sender = recorder();
    const res = await post(appWith(sender), form("just words"));
    expect(res.status).toBe(200);
    const wire = (await res.json()) as FeedbackWire;
    expect(wire.emailStatus).toBe("sent");
    expect(JSON.parse((await rowFor(wire.id))!.images_json)).toEqual([]);
    expect(sender.sent[0]!.attachments).toEqual([]);
  });
});

describe("POST /api/feedback — when mail cannot go out, the feedback stays", () => {
  it("no sender (no EMAIL binding) → stored, unsent", async () => {
    const res = await post(
      appWith(null),
      form("stored without a binding", [{ bytes: PNG, name: "a.png", type: "image/png" }]),
    );
    expect(res.status).toBe(200);
    const wire = (await res.json()) as FeedbackWire;
    expect(wire.emailStatus).toBe("unsent");

    const row = await rowFor(wire.id);
    expect(row!.email_status).toBe("unsent");
    expect(row!.email_error).toBeNull();
    expect(await env.RECEIPTS.head(`u/${U1}/feedback/${wire.id}/0`)).not.toBeNull();
  });

  it("sender throws → stored, failed, with the message", async () => {
    const thrower: EmailSender = {
      send: async () => {
        throw new Error("sender domain not verified");
      },
    };
    const res = await post(appWith(thrower), form("stored despite the throw"));
    expect(res.status).toBe(200);
    const wire = (await res.json()) as FeedbackWire;
    expect(wire.emailStatus).toBe("failed");

    const row = await rowFor(wire.id);
    expect(row!.email_status).toBe("failed");
    expect(row!.email_error).toBe("sender domain not verified");
    expect(row!.message).toBe("stored despite the throw");
  });

  it("no admins → stored, unsent, and the sender is never asked", async () => {
    const sender = recorder();
    const res = await post(appWith(sender), form("nobody to mail"), {
      envOverrides: { ADMIN_EMAILS: "" },
    });
    expect(res.status).toBe(200);
    const wire = (await res.json()) as FeedbackWire;
    expect(wire.emailStatus).toBe("unsent");
    expect((await rowFor(wire.id))!.email_status).toBe("unsent");
    expect(sender.sent).toHaveLength(0);
  });

  it("no sender address → stored, unsent, and the sender is never asked", async () => {
    const sender = recorder();
    const res = await post(appWith(sender), form("no from address"), {
      envOverrides: { FEEDBACK_FROM: "" },
    });
    const wire = (await res.json()) as FeedbackWire;
    expect(wire.emailStatus).toBe("unsent");
    expect(sender.sent).toHaveLength(0);
  });
});

describe("POST /api/feedback — validation refuses and stores nothing", () => {
  async function expectNothingStored(
    body: FormData,
    status: number,
  ): Promise<{ error: string }> {
    const sender = recorder();
    const rowsBefore = await rowCount();
    const keysBefore = await imageKeysFor(U1);

    const res = await post(appWith(sender), body);
    expect(res.status).toBe(status);

    expect(await rowCount()).toBe(rowsBefore);
    expect(await imageKeysFor(U1)).toEqual(keysBefore);
    expect(sender.sent).toHaveLength(0);
    return (await res.json()) as { error: string };
  }

  it("400s an empty message", async () => {
    const body = await expectNothingStored(
      form("   \n ", [{ bytes: PNG, name: "a.png", type: "image/png" }]),
      400,
    );
    expect(body.error).toMatch(/message/);
  });

  it("400s a missing message part", async () => {
    const fd = new FormData();
    fd.append("image", new File([PNG], "a.png", { type: "image/png" }));
    await expectNothingStored(fd, 400);
  });

  it("400s a message over 4000 characters", async () => {
    await expectNothingStored(form("x".repeat(4001)), 400);
  });

  it("400s more than five images", async () => {
    const six = Array.from({ length: 6 }, (_, i) => ({
      bytes: PNG,
      name: `s${i}.png`,
      type: "image/png",
    }));
    const body = await expectNothingStored(form("too many", six), 400);
    expect(body.error).toMatch(/5 images/);
  });

  it("413s one image over 8 MB", async () => {
    const huge = new Uint8Array(MAX_IMAGE_BYTES + 1);
    const body = await expectNothingStored(
      form("too big", [{ bytes: huge, name: "huge.png", type: "image/png" }]),
      413,
    );
    expect(body.error).toMatch(/huge\.png/);
  });

  it("413s images over 20 MB together even when each is under 8 MB", async () => {
    // Three at 7 MB: each passes the per-image cap, the sum does not.
    const seven = new Uint8Array(7 * 1024 * 1024);
    expect(3 * seven.length).toBeGreaterThan(MAX_TOTAL_IMAGE_BYTES);
    const body = await expectNothingStored(
      form("too much", [
        { bytes: seven, name: "a.png", type: "image/png" },
        { bytes: seven, name: "b.png", type: "image/png" },
        { bytes: seven, name: "c.png", type: "image/png" },
      ]),
      413,
    );
    expect(body.error).toMatch(/together/);
  });

  it("400s a part that is not an image", async () => {
    const body = await expectNothingStored(
      form("not a picture", [
        { bytes: new TextEncoder().encode("%PDF-1.4"), name: "doc.pdf", type: "application/pdf" },
      ]),
      400,
    );
    expect(body.error).toMatch(/doc\.pdf/);
  });

  it("400s an `image` part that is a string, not a file", async () => {
    const fd = form("string part");
    fd.append("image", "not-a-file");
    await expectNothingStored(fd, 400);
  });

  it("400s a body that is not multipart", async () => {
    const token = await issueAccessToken({ userId: U1, secret: env.AUTH_SECRET, ttlSeconds: 900 });
    const res = await appWith(recorder()).request(
      "/api/feedback",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ message: "json" }),
      },
      env as unknown as Bindings,
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/feedback — the daily cap", () => {
  it("429s the 21st submission of a UTC day and stores nothing for it", async () => {
    // A user of their own, so the rows other tests wrote do not count.
    const capped = "feedback-capped-user";
    await seedUser(env.DB, capped);
    const repo = FeedbackRepo.for(env.DB);
    const now = Date.now();
    for (let i = 0; i < FEEDBACK_DAILY_CAP; i += 1) {
      await repo.insert(capped, {
        id: crypto.randomUUID(),
        userEmail: `${capped}@example.com`,
        message: `earlier today #${i}`,
        page: null,
        clientVersion: null,
        userAgent: null,
        images: [],
        emailStatus: "unsent",
        now,
      });
    }
    expect(await repo.countSince(capped, now - 1)).toBe(FEEDBACK_DAILY_CAP);

    const sender = recorder();
    const res = await post(appWith(sender), form("one too many"), { userId: capped });
    expect(res.status).toBe(429);
    expect(await repo.countSince(capped, now - 1)).toBe(FEEDBACK_DAILY_CAP);
    expect(sender.sent).toHaveLength(0);
  });

  it("does not count yesterday's submissions", async () => {
    const fresh = "feedback-fresh-user";
    await seedUser(env.DB, fresh);
    const repo = FeedbackRepo.for(env.DB);
    const yesterday = Date.now() - 36 * 60 * 60 * 1000;
    for (let i = 0; i < FEEDBACK_DAILY_CAP; i += 1) {
      await repo.insert(fresh, {
        id: crypto.randomUUID(),
        userEmail: `${fresh}@example.com`,
        message: `yesterday #${i}`,
        page: null,
        clientVersion: null,
        userAgent: null,
        images: [],
        emailStatus: "sent",
        now: yesterday,
      });
    }

    const res = await post(appWith(recorder()), form("today is a new day"), { userId: fresh });
    expect(res.status).toBe(200);
  });
});

describe("POST /api/feedback — through the real worker", () => {
  it("401s without a token", async () => {
    const res = await SELF.fetch("https://localhost/api/feedback", {
      method: "POST",
      body: form("no token"),
    });
    expect(res.status).toBe(401);
  });

  it("is mounted, and with no EMAIL binding stores the feedback unsent", async () => {
    // The default factory (senderFromEnv) sees no binding in the test
    // runtime — the same shape as every deployment before Email
    // Sending is turned on — so the row must still land.
    const token = await issueAccessToken({ userId: U1, secret: env.AUTH_SECRET, ttlSeconds: 900 });
    const res = await SELF.fetch("https://localhost/api/feedback", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form("via SELF", [{ bytes: PNG, name: "a.png", type: "image/png" }]),
    });
    expect(res.status).toBe(200);
    const wire = (await res.json()) as FeedbackWire;
    expect(wire.emailStatus).toBe("unsent");
    const row = await rowFor(wire.id);
    expect(row!.message).toBe("via SELF");
    expect(row!.email_status).toBe("unsent");
  });
});
