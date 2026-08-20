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

  // The third door onto a payment write. Before this, confirming a
  // receipt against a gig wrote payments.gig_id and stopped there — no
  // allocation row, so services/paid-totals.ts had nothing to sum and
  // the gig stayed at NULL while the user looked at a payment that
  // plainly named it. Read straight out of D1 rather than through a
  // route: GET /api/gigs/:id could compute a total on the way out and
  // hide a column that was never written.
  it("translates the legacy gigId into an allocation and the gig's derived total", async () => {
    const gigId = "1a1a1a1a-aaaa-4aaa-8aaa-1a1a1a1a1a1a";
    await api(U1, "PUT", `/api/gigs/${gigId}`, {
      status: "completed",
      amountOfferedCents: 20000,
    });

    const draftId = "1b1b1b1b-dddd-4ddd-8ddd-1b1b1b1b1b1b";
    await seedDraft(U1, draftId);
    const paymentId = "1c1c1c1c-aaaa-4aaa-8aaa-1c1c1c1c1c1c";

    const res = await api(U1, "POST", `/api/drafts/${draftId}/confirm-payment`, {
      id: paymentId,
      amountCents: 5000,
      gigId,
    });
    expect(res.status).toBe(201);

    const allocations = await env.DB.prepare(
      "SELECT gig_id, amount_cents FROM payment_allocations WHERE user_id = ? AND payment_id = ?",
    )
      .bind(U1, paymentId)
      .all<{ gig_id: string; amount_cents: number }>();
    expect(allocations.results).toEqual([
      { gig_id: gigId, amount_cents: 5000 },
    ]);

    const gig = await env.DB.prepare("SELECT amount_paid_cents FROM gigs WHERE id = ?")
      .bind(gigId)
      .first<{ amount_paid_cents: number | null }>();
    expect(gig?.amount_paid_cents).toBe(5000);
  });

  it("leaves the gig's derived total alone when the confirmation names no gig", async () => {
    // The other half of the branch: an unattributed receipt must not
    // invent an allocation, and no gig's total may move because of it.
    const gigId = "2a2a2a2a-aaaa-4aaa-8aaa-2a2a2a2a2a2a";
    await api(U1, "PUT", `/api/gigs/${gigId}`, {
      status: "completed",
      amountOfferedCents: 20000,
    });

    const draftId = "2b2b2b2b-dddd-4ddd-8ddd-2b2b2b2b2b2b";
    await seedDraft(U1, draftId);
    const paymentId = "2c2c2c2c-aaaa-4aaa-8aaa-2c2c2c2c2c2c";

    const res = await api(U1, "POST", `/api/drafts/${draftId}/confirm-payment`, {
      id: paymentId,
      amountCents: 5000,
    });
    expect(res.status).toBe(201);

    const allocations = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM payment_allocations WHERE user_id = ? AND payment_id = ?",
    )
      .bind(U1, paymentId)
      .first<{ n: number }>();
    expect(allocations?.n).toBe(0);

    const gig = await env.DB.prepare("SELECT amount_paid_cents FROM gigs WHERE id = ?")
      .bind(gigId)
      .first<{ amount_paid_cents: number | null }>();
    expect(gig?.amount_paid_cents).toBeNull();
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

  it("409s when the payment id already exists, and never touches it", async () => {
    const existingId = "eeeeeeee-1111-4111-8111-eeeeeeeeeeee";
    await api(U1, "PUT", `/api/payments/${existingId}`, {
      amountCents: 9999,
      notes: "original",
    });

    const draftId = "eeeeeeee-2222-4222-8222-eeeeeeeeeeee";
    await seedDraft(U1, draftId);
    const res = await api(U1, "POST", `/api/drafts/${draftId}/confirm-payment`, {
      id: existingId,
      amountCents: 1000,
      notes: "from the draft",
    });
    expect(res.status).toBe(409);

    // Neither the fields nor the confirmation photo were overwritten —
    // this route means create, not upsert.
    const payment = (await (await api(U1, "GET", `/api/payments/${existingId}`)).json()) as {
      amountCents: number;
      notes: string;
    };
    expect(payment.amountCents).toBe(9999);
    expect(payment.notes).toBe("original");

    // The draft is untouched too — a rejected confirmation must not
    // burn the one-way pending→confirmed transition.
    const draft = (await (await api(U1, "GET", `/api/drafts/${draftId}`)).json()) as {
      status: string;
    };
    expect(draft.status).toBe("pending");
  });

  it("two concurrent confirmations of the same draft create at most one payment", async () => {
    // Regression probe for the race where setStatus was read-then-write:
    // both requests could observe "pending" before either write landed,
    // and each would go on to create its own payment from the same
    // receipt. setStatus's WHERE-clause compare-and-set (repos/drafts.ts)
    // is what makes only one of these two requests able to proceed.
    const draftId = "ffffffff-1111-4111-8111-ffffffffffff";
    await seedDraft(U1, draftId);
    const candidateA = "ffffffff-2222-4222-8222-ffffffffffff";
    const candidateB = "ffffffff-3333-4333-8333-ffffffffffff";

    const [resA, resB] = await Promise.all([
      api(U1, "POST", `/api/drafts/${draftId}/confirm-payment`, {
        id: candidateA,
        amountCents: 1000,
      }),
      api(U1, "POST", `/api/drafts/${draftId}/confirm-payment`, {
        id: candidateB,
        amountCents: 1000,
      }),
    ]);

    expect([resA.status, resB.status].sort()).toEqual([201, 409]);

    const [gotA, gotB] = await Promise.all([
      api(U1, "GET", `/api/payments/${candidateA}`),
      api(U1, "GET", `/api/payments/${candidateB}`),
    ]);
    expect([gotA.status, gotB.status].filter((s) => s === 200)).toHaveLength(1);

    const draft = (await (await api(U1, "GET", `/api/drafts/${draftId}`)).json()) as {
      status: string;
    };
    expect(draft.status).toBe("confirmed");
  });

  it("reopens the draft — rather than stranding it confirmed — when payment creation is refused after the close", async () => {
    // Owned by U2. The route's own precheck (paymentsRepo.get scoped to
    // the CALLER's userId) won't see it, so U1's confirm-payment
    // proceeds far enough to close U1's draft before PaymentsRepo.upsert
    // discovers the id belongs to someone else and returns "forbidden" —
    // exactly the "failure after close" window reopen() exists for.
    const collidingId = "12121212-aaaa-4aaa-8aaa-121212121212";
    await api(U2, "PUT", `/api/payments/${collidingId}`, { amountCents: 500 });

    const draftId = "13131313-dddd-4ddd-8ddd-131313131313";
    await seedDraft(U1, draftId);

    const res = await api(U1, "POST", `/api/drafts/${draftId}/confirm-payment`, {
      id: collidingId,
      amountCents: 1000,
    });
    expect(res.status).toBe(404);

    // Not stranded "confirmed" with no payment — back to pending, so
    // Drafts.tsx lists it again and the user can simply retry.
    const draft = (await (await api(U1, "GET", `/api/drafts/${draftId}`)).json()) as {
      status: string;
    };
    expect(draft.status).toBe("pending");

    // U2's original payment is untouched.
    const theirs = (await (await api(U2, "GET", `/api/payments/${collidingId}`)).json()) as {
      amountCents: number;
    };
    expect(theirs.amountCents).toBe(500);

    // And the reopened draft is genuinely usable again, not just
    // readable — the whole point of reopening is that a retry works.
    const retryId = "14141414-aaaa-4aaa-8aaa-141414141414";
    const retry = await api(U1, "POST", `/api/drafts/${draftId}/confirm-payment`, {
      id: retryId,
      amountCents: 1000,
    });
    expect(retry.status).toBe(201);
  });
});
