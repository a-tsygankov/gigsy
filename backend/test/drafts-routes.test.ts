/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeAll } from "vitest";
import { SELF, env } from "cloudflare:test";
import { applyMigrations, seedUser } from "./helpers/db.ts";
import { api } from "./helpers/api.ts";
import { DraftsRepo } from "../src/repos/drafts.ts";

const U1 = "user-1";
const U2 = "user-2";
const D1 = "11111111-dddd-4ddd-8ddd-111111111111";

async function seedDraft(
  userId: string,
  id: string,
  overrides: Partial<{ status: "pending" | "confirmed" | "discarded"; rawR2Key: string | null }> = {},
) {
  await DraftsRepo.for(env.DB).insert(userId, {
    id,
    source: "photo",
    status: overrides.status ?? "pending",
    rawR2Key: overrides.rawR2Key ?? null,
    extractedJson: JSON.stringify({ kind: "gig", clientName: "Acme" }),
    now: 1000,
  });
}

beforeAll(async () => {
  await applyMigrations(env.DB);
  await seedUser(env.DB, U1);
  await seedUser(env.DB, U2);
});

describe("/api/drafts", () => {
  it("401s without a token", async () => {
    const res = await SELF.fetch("https://localhost/api/drafts");
    expect(res.status).toBe(401);
  });

  it("lists own drafts, filterable by status", async () => {
    await seedDraft(U1, D1);
    const pending = (await (
      await api(U1, "GET", "/api/drafts?status=pending")
    ).json()) as { items: { id: string; extracted: { clientName: string } }[] };
    expect(pending.items.map((d) => d.id)).toEqual([D1]);
    expect(pending.items[0]?.extracted.clientName).toBe("Acme");

    const theirs = (await (await api(U2, "GET", "/api/drafts")).json()) as {
      items: unknown[];
    };
    expect(theirs.items).toEqual([]);
  });

  it("transitions pending → confirmed; repeat transition is a 409", async () => {
    await seedDraft(U1, D1);
    const ok = await api(U1, "PUT", `/api/drafts/${D1}`, {
      status: "confirmed",
    });
    expect(ok.status).toBe(200);

    const again = await api(U1, "PUT", `/api/drafts/${D1}`, {
      status: "discarded",
    });
    expect(again.status).toBe(409);
  });

  it("404s transitions on another user's draft", async () => {
    await seedDraft(U1, D1);
    const res = await api(U2, "PUT", `/api/drafts/${D1}`, {
      status: "discarded",
    });
    expect(res.status).toBe(404);
  });

  it("streams the raw capture back; 404 when absent or foreign", async () => {
    const key = `u/${U1}/captures/${D1}`;
    await env.RECEIPTS.put(key, new Uint8Array([1, 2, 3]), {
      httpMetadata: { contentType: "image/png" },
    });
    await seedDraft(U1, D1, { rawR2Key: key });

    const res = await api(U1, "GET", `/api/drafts/${D1}/raw`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    // Consume the stream — an open R2 body keeps the object file
    // locked on Windows and fails miniflare's storage teardown.
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );

    const foreign = await api(U2, "GET", `/api/drafts/${D1}/raw`);
    expect(foreign.status).toBe(404);
    await foreign.text();
  });
});
