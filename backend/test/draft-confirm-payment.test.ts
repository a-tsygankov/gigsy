/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations, seedUser } from "./helpers/db.ts";
import { api } from "./helpers/api.ts";
import { DraftsRepo } from "../src/repos/drafts.ts";

const U1 = "user-1";
const U2 = "user-2";
const D1 = "11111111-dddd-4ddd-8ddd-111111111111";
const D2 = "22222222-dddd-4ddd-8ddd-222222222222";
const D3 = "33333333-dddd-4ddd-8ddd-333333333333";
const PAY = "44444444-eeee-4eee-8eee-444444444444";
const GIG = "55555555-aaaa-4aaa-8aaa-555555555555";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

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
    extractedJson: JSON.stringify({ kind: "payment", clientName: "Acme", amountCents: 5000 }),
    now: 1000,
  });
}

beforeAll(async () => {
  await applyMigrations(env.DB);
  await seedUser(env.DB, U1);
  await seedUser(env.DB, U2);
});

describe("POST /api/drafts/:id/confirm-payment", () => {
  it("creates the payment, copies the draft's photo to its confirmation key, and closes the draft", async () => {
    const key = `u/${U1}/captures/${D1}`;
    await env.RECEIPTS.put(key, PNG, { httpMetadata: { contentType: "image/png" } });
    await seedDraft(U1, D1, { rawR2Key: key });

    const res = await api(U1, "POST", `/api/drafts/${D1}/confirm-payment`, {
      id: PAY,
      amountCents: 5000,
      notes: "Zelle",
    });
    expect(res.status).toBe(201);
    const payment = (await res.json()) as {
      id: string;
      amountCents: number;
      confirmationR2Key: string | null;
    };
    expect(payment.id).toBe(PAY);
    expect(payment.amountCents).toBe(5000);
    expect(payment.confirmationR2Key).toBe(`u/${U1}/payments/${PAY}/confirmation`);

    // The bytes actually made it to the payment's own key — not just a
    // key name recorded without the object behind it.
    const confirmation = await api(U1, "GET", `/api/payments/${PAY}/confirmation`);
    expect(confirmation.status).toBe(200);
    expect(new Uint8Array(await confirmation.arrayBuffer())).toEqual(PNG);

    const draft = (await (await api(U1, "GET", `/api/drafts/${D1}`)).json()) as {
      status: string;
    };
    expect(draft.status).toBe("confirmed");
  });

  it("still creates the payment and closes the draft when there is no photo to copy", async () => {
    await seedDraft(U1, D2, { rawR2Key: null });

    const paymentId = "66666666-ffff-4fff-8fff-666666666666";
    const res = await api(U1, "POST", `/api/drafts/${D2}/confirm-payment`, {
      id: paymentId,
      amountCents: 2500,
    });
    expect(res.status).toBe(201);
    const payment = (await res.json()) as { confirmationR2Key: string | null };
    expect(payment.confirmationR2Key).toBeNull();

    const draft = (await (await api(U1, "GET", `/api/drafts/${D2}`)).json()) as {
      status: string;
    };
    expect(draft.status).toBe("confirmed");
  });

  it("still creates the payment when the draft's photo object is missing from R2", async () => {
    // rawR2Key points somewhere real but nothing was ever put there —
    // the copy is best-effort and must not take the payment down with it.
    await seedDraft(U1, D3, { rawR2Key: `u/${U1}/captures/${D3}` });

    const paymentId = "77777777-aaaa-4aaa-8aaa-777777777777";
    const res = await api(U1, "POST", `/api/drafts/${D3}/confirm-payment`, {
      id: paymentId,
      amountCents: 1000,
    });
    expect(res.status).toBe(201);
    const payment = (await res.json()) as { confirmationR2Key: string | null };
    expect(payment.confirmationR2Key).toBeNull();
  });

  it("400s a gigId that is not the caller's", async () => {
    const draftId = "88888888-dddd-4ddd-8ddd-888888888888";
    await seedDraft(U1, draftId);
    const res = await api(U1, "POST", `/api/drafts/${draftId}/confirm-payment`, {
      id: "99999999-aaaa-4aaa-8aaa-999999999999",
      amountCents: 1000,
      gigId: GIG,
    });
    expect(res.status).toBe(400);
  });

  it("404s on a draft that is not the caller's", async () => {
    const draftId = "aaaaaaaa-dddd-4ddd-8ddd-aaaaaaaaaaaa";
    await seedDraft(U1, draftId);
    const res = await api(U2, "POST", `/api/drafts/${draftId}/confirm-payment`, {
      id: "bbbbbbbb-aaaa-4aaa-8aaa-bbbbbbbbbbbb",
      amountCents: 1000,
    });
    expect(res.status).toBe(404);
  });

  it("409s confirming an already-reviewed draft", async () => {
    const draftId = "cccccccc-dddd-4ddd-8ddd-cccccccccccc";
    await seedDraft(U1, draftId, { status: "discarded" });
    const res = await api(U1, "POST", `/api/drafts/${draftId}/confirm-payment`, {
      id: "dddddddd-aaaa-4aaa-8aaa-dddddddddddd",
      amountCents: 1000,
    });
    expect(res.status).toBe(409);
  });
});
