/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeAll } from "vitest";
import { SELF, env } from "cloudflare:test";
import { Hono } from "hono";
import { applyMigrations, seedUser } from "./helpers/db.ts";
import { api } from "./helpers/api.ts";
import { issueAccessToken } from "../src/auth/tokens.ts";
import { makeCaptureRouter } from "../src/routes/capture.ts";
import { StubProvider } from "../src/capture/providers.ts";
import type { Bindings } from "../src/env.ts";

const U1 = "user-1";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9, 9]);

type DraftWire = {
  id: string;
  source: string;
  status: string;
  rawR2Key: string | null;
  extracted: {
    kind: string;
    clientName?: string | null;
    matchedClientId?: string | null;
    matchConfidence?: number | null;
  };
};

async function capturePhoto(userId: string): Promise<Response> {
  const token = await issueAccessToken({
    userId,
    secret: env.AUTH_SECRET,
    ttlSeconds: 900,
  });
  return SELF.fetch("https://localhost/api/capture/photo", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "image/png" },
    body: PNG,
  });
}

beforeAll(async () => {
  await applyMigrations(env.DB);
  await seedUser(env.DB, U1);
});

describe("POST /api/capture/photo", () => {
  it("401s without a token", async () => {
    const res = await SELF.fetch("https://localhost/api/capture/photo", {
      method: "POST",
      body: PNG,
    });
    expect(res.status).toBe(401);
  });

  it("stores the photo, extracts, and returns a pending draft", async () => {
    const res = await capturePhoto(U1);
    expect(res.status).toBe(200);
    const draft = (await res.json()) as DraftWire;

    expect(draft.source).toBe("photo");
    expect(draft.status).toBe("pending");
    expect(draft.extracted.kind).toBe("gig");
    expect(draft.extracted.clientName).toBe("Stub Staffing Co");
    expect(draft.rawR2Key).toBe(`u/${U1}/captures/${draft.id}`);

    const raw = await api(U1, "GET", `/api/drafts/${draft.id}/raw`);
    expect(raw.status).toBe(200);
    expect(new Uint8Array(await raw.arrayBuffer())).toEqual(PNG);
  });

  it("fuzzy-matches the extracted client against existing clients", async () => {
    const CLIENT = "11111111-cccc-4ccc-8ccc-111111111111";
    await api(U1, "PUT", `/api/clients/${CLIENT}`, {
      name: "Stub Staffing Co",
    });

    const draft = (await (await capturePhoto(U1)).json()) as DraftWire;
    expect(draft.extracted.matchedClientId).toBe(CLIENT);
    expect(draft.extracted.matchConfidence).toBe(1);
  });

  it("400s an empty body", async () => {
    const token = await issueAccessToken({
      userId: U1,
      secret: env.AUTH_SECRET,
      ttlSeconds: 900,
    });
    const res = await SELF.fetch("https://localhost/api/capture/photo", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(400);
  });
});

describe("capture router (unit — injected provider)", () => {
  function appWith(
    providerOk: boolean,
    envOverrides: Partial<Bindings> = {},
  ): { app: Hono; callEnv: Bindings } {
    const factory = () =>
      providerOk
        ? new StubProvider()
        : { extract: async () => null };
    const app = new Hono().route("/api/capture", makeCaptureRouter(factory));
    return { app, callEnv: { ...env, ...envOverrides } as Bindings };
  }

  async function post(app: Hono, callEnv: Bindings): Promise<Response> {
    const token = await issueAccessToken({
      userId: U1,
      secret: env.AUTH_SECRET,
      ttlSeconds: 900,
    });
    return app.request(
      "/api/capture/photo",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "content-type": "image/png" },
        body: PNG,
      },
      callEnv,
    );
  }

  it("502s when extraction fails — and creates NO draft", async () => {
    const before = (
      (await (await api(U1, "GET", "/api/drafts")).json()) as { items: unknown[] }
    ).items.length;

    const { app, callEnv } = appWith(false);
    const res = await post(app, callEnv);
    expect(res.status).toBe(502);

    const after = (
      (await (await api(U1, "GET", "/api/drafts")).json()) as { items: unknown[] }
    ).items.length;
    expect(after).toBe(before);
  });

  it("429s past the daily cap", async () => {
    const { app, callEnv } = appWith(true, { AI_DAILY_CAP: "1" });
    expect((await post(app, callEnv)).status).toBe(200);
    expect((await post(app, callEnv)).status).toBe(429);
  });
});
