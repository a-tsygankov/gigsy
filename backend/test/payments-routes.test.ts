/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations, seedUser } from "./helpers/db.ts";
import { api } from "./helpers/api.ts";

const U1 = "user-1";

const CLIENT_1 = "10000000-1111-4111-8111-100000000001";
const CLIENT_2 = "20000000-2222-4222-8222-200000000002";
const GIG_1 = "30000000-3333-4333-8333-300000000003";
const GIG_2 = "40000000-4444-4444-8444-400000000004";
const PAY = "50000000-5555-4555-8555-500000000005";
const ALLOC = "60000000-6666-4666-8666-600000000006";

type PaymentBody = {
  clientId: string | null;
  amountCents: number;
  allocatedCents?: number;
  unallocatedCents?: number;
};
type GigBody = { amountPaidCents: number | null };

const getPayment = async (id: string) =>
  (await (await api(U1, "GET", `/api/payments/${id}`)).json()) as PaymentBody;
const getGig = async (id: string) =>
  (await (await api(U1, "GET", `/api/gigs/${id}`)).json()) as GigBody;
const listAllocations = async (query: string) =>
  ((await (await api(U1, "GET", `/api/allocations?${query}`)).json()) as {
    items: unknown[];
  }).items;

beforeEach(async () => {
  await applyMigrations(env.DB);
  await seedUser(env.DB, U1);
  await api(U1, "PUT", `/api/clients/${CLIENT_1}`, { name: "Client One" });
  await api(U1, "PUT", `/api/clients/${CLIENT_2}`, { name: "Client Two" });
  await api(U1, "PUT", `/api/gigs/${GIG_1}`, {
    status: "completed", amountOfferedCents: 10000, clientId: CLIENT_1,
  });
  await api(U1, "PUT", `/api/gigs/${GIG_2}`, {
    status: "completed", amountOfferedCents: 10000, clientId: CLIENT_2,
  });
});

describe("PUT /api/payments/:id — clientId preserve-on-absent", () => {
  it("preserves a stored clientId when a later payload omits it", async () => {
    await api(U1, "PUT", `/api/payments/${PAY}`, {
      amountCents: 5000, clientId: CLIENT_1,
    });
    expect((await getPayment(PAY)).clientId).toBe(CLIENT_1);

    // The shipped webapp's outbox payload doesn't send clientId at
    // all — this mirrors that shape exactly.
    const res = await api(U1, "PUT", `/api/payments/${PAY}`, { amountCents: 5500 });
    expect(res.status).toBe(200);
    expect((await getPayment(PAY)).clientId).toBe(CLIENT_1);
    expect((await getPayment(PAY)).amountCents).toBe(5500);
  });

  it("clears clientId when a payload sends it explicitly as null", async () => {
    await api(U1, "PUT", `/api/payments/${PAY}`, {
      amountCents: 5000, clientId: CLIENT_1,
    });
    await api(U1, "PUT", `/api/payments/${PAY}`, { amountCents: 5000, clientId: null });
    expect((await getPayment(PAY)).clientId).toBeNull();
  });
});

describe("DELETE /api/payments/:id — cascades allocations", () => {
  it("deletes an allocated payment and clears the gig's derived total", async () => {
    await api(U1, "PUT", `/api/payments/${PAY}`, { amountCents: 6000 });
    await api(U1, "PUT", `/api/allocations/${ALLOC}`, {
      paymentId: PAY, gigId: GIG_1, amountCents: 6000,
    });
    expect((await getGig(GIG_1)).amountPaidCents).toBe(6000);

    const res = await api(U1, "DELETE", `/api/payments/${PAY}`);
    expect(res.status).toBe(204);
    expect((await api(U1, "GET", `/api/payments/${PAY}`)).status).toBe(404);
    expect((await getGig(GIG_1)).amountPaidCents).toBeNull();
    expect(await listAllocations(`gigId=${GIG_1}`)).toHaveLength(0);
  });
});

describe("the gigId compat path respects the client rule", () => {
  it("refuses a legacy gigId that belongs to a different client", async () => {
    await api(U1, "PUT", `/api/payments/${PAY}`, {
      amountCents: 10000, clientId: CLIENT_1,
    });
    const res = await api(U1, "PUT", `/api/payments/${PAY}`, {
      amountCents: 10000, clientId: CLIENT_1, gigId: GIG_2,
    });
    expect(res.status).toBe(400);
    expect(await listAllocations(`paymentId=${PAY}`)).toHaveLength(0);
  });

  it("accepts a legacy gigId that matches the payment's client", async () => {
    await api(U1, "PUT", `/api/payments/${PAY}`, {
      amountCents: 10000, clientId: CLIENT_1,
    });
    const res = await api(U1, "PUT", `/api/payments/${PAY}`, {
      amountCents: 10000, clientId: CLIENT_1, gigId: GIG_1,
    });
    expect(res.status).toBe(200);
    expect(await listAllocations(`paymentId=${PAY}`)).toHaveLength(1);
  });
});

// The route door onto the same guard services/sync.ts is tested for.
// Both doors reach AllocationsRepo.replaceSoleAllocation, and this
// codebase has repeatedly had an invariant fixed at one door and not
// the other — hence a paired test rather than one.
//
// Asserted straight out of D1: GET /api/payments/:id computes
// allocatedCents on the way out, so a route read could look right over
// rows that are wrong.
describe("a legacy gigId must not destroy an existing split", () => {
  const ALLOC_2 = "70000000-7777-4777-8777-700000000007";

  const allocationRows = async (paymentId: string) =>
    (
      await env.DB.prepare(
        "SELECT gig_id AS gigId, amount_cents AS amountCents FROM payment_allocations WHERE payment_id = ? ORDER BY gig_id",
      )
        .bind(paymentId)
        .all<{ gigId: string; amountCents: number }>()
    ).results;

  const paidCents = async (gigId: string) =>
    (
      await env.DB.prepare(
        "SELECT amount_paid_cents AS amountPaidCents FROM gigs WHERE id = ?",
      )
        .bind(gigId)
        .first<{ amountPaidCents: number | null }>()
    )?.amountPaidCents ?? null;

  /** A 10000 payment split 4000/3000 across two gigs. The payment
   *  carries no clientId, which is what lets it allocate to gigs
   *  belonging to two different clients. */
  async function seedSplit(): Promise<void> {
    await api(U1, "PUT", `/api/payments/${PAY}`, { amountCents: 10000 });
    await api(U1, "PUT", `/api/allocations/${ALLOC}`, {
      paymentId: PAY, gigId: GIG_1, amountCents: 4000,
    });
    await api(U1, "PUT", `/api/allocations/${ALLOC_2}`, {
      paymentId: PAY, gigId: GIG_2, amountCents: 3000,
    });
    expect(await allocationRows(PAY)).toHaveLength(2);
  }

  it("leaves both allocations and both derived totals untouched", async () => {
    await seedSplit();

    // Exactly what the shipped webapp sends on any payment edit: it
    // predates allocations, so gigId rides along on every write.
    const res = await api(U1, "PUT", `/api/payments/${PAY}`, {
      amountCents: 10000, gigId: GIG_1, notes: "edited on an old build",
    });
    expect(res.status).toBe(200);

    expect(await allocationRows(PAY)).toEqual([
      { gigId: GIG_1, amountCents: 4000 },
      { gigId: GIG_2, amountCents: 3000 },
    ]);
    expect(await paidCents(GIG_1)).toBe(4000);
    expect(await paidCents(GIG_2)).toBe(3000);
    // The rest of the payment write still lands — only the allocations
    // are off limits.
    expect((await getPayment(PAY)).amountCents).toBe(10000);
  });

  it("refuses a legacy write that would shrink the payment below the preserved split", async () => {
    await seedSplit();

    // I4 is skipped on the compat path because that path used to resize
    // every allocation to the new amount. It no longer does when a
    // split survives, so the shrink refusal has to apply here again.
    const res = await api(U1, "PUT", `/api/payments/${PAY}`, {
      amountCents: 5000, gigId: GIG_1,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(
      /amountCents is less than the payment's allocated total/,
    );
    expect((await getPayment(PAY)).amountCents).toBe(10000);
    expect(await allocationRows(PAY)).toHaveLength(2);
  });

  it("still replaces a lone allocation, including moving it to another gig", async () => {
    await api(U1, "PUT", `/api/payments/${PAY}`, { amountCents: 10000 });
    await api(U1, "PUT", `/api/allocations/${ALLOC}`, {
      paymentId: PAY, gigId: GIG_1, amountCents: 4000,
    });

    const res = await api(U1, "PUT", `/api/payments/${PAY}`, {
      amountCents: 9000, gigId: GIG_2,
    });
    expect(res.status).toBe(200);

    expect(await allocationRows(PAY)).toEqual([
      { gigId: GIG_2, amountCents: 9000 },
    ]);
    expect(await paidCents(GIG_1)).toBeNull();
    expect(await paidCents(GIG_2)).toBe(9000);
  });
});

describe("shrinking a payment below its allocated total", () => {
  it("is rejected", async () => {
    await api(U1, "PUT", `/api/payments/${PAY}`, { amountCents: 10000 });
    await api(U1, "PUT", `/api/allocations/${ALLOC}`, {
      paymentId: PAY, gigId: GIG_1, amountCents: 10000,
    });
    const res = await api(U1, "PUT", `/api/payments/${PAY}`, { amountCents: 100 });
    expect(res.status).toBe(400);
    // Nothing changed: neither the payment nor the allocation moved.
    expect((await getPayment(PAY)).amountCents).toBe(10000);
    expect((await getGig(GIG_1)).amountPaidCents).toBe(10000);
  });

  it("allows shrinking down to exactly the allocated total", async () => {
    await api(U1, "PUT", `/api/payments/${PAY}`, { amountCents: 10000 });
    await api(U1, "PUT", `/api/allocations/${ALLOC}`, {
      paymentId: PAY, gigId: GIG_1, amountCents: 6000,
    });
    const res = await api(U1, "PUT", `/api/payments/${PAY}`, { amountCents: 6000 });
    expect(res.status).toBe(200);
    expect((await getPayment(PAY)).unallocatedCents).toBe(0);
  });
});

describe("changing clientId away from an already-allocated gig's client", () => {
  it("is rejected", async () => {
    await api(U1, "PUT", `/api/payments/${PAY}`, { amountCents: 10000 });
    await api(U1, "PUT", `/api/allocations/${ALLOC}`, {
      paymentId: PAY, gigId: GIG_1, amountCents: 10000,
    });
    const res = await api(U1, "PUT", `/api/payments/${PAY}`, {
      amountCents: 10000, clientId: CLIENT_2,
    });
    expect(res.status).toBe(400);
    expect((await getPayment(PAY)).clientId).toBeNull();
  });

  it("is accepted when it matches the allocated gig's client", async () => {
    await api(U1, "PUT", `/api/payments/${PAY}`, { amountCents: 10000 });
    await api(U1, "PUT", `/api/allocations/${ALLOC}`, {
      paymentId: PAY, gigId: GIG_1, amountCents: 10000,
    });
    const res = await api(U1, "PUT", `/api/payments/${PAY}`, {
      amountCents: 10000, clientId: CLIENT_1,
    });
    expect(res.status).toBe(200);
    expect((await getPayment(PAY)).clientId).toBe(CLIENT_1);
  });

  it("always allows narrowing clientId to null, even with existing allocations", async () => {
    await api(U1, "PUT", `/api/payments/${PAY}`, {
      amountCents: 10000, clientId: CLIENT_1,
    });
    await api(U1, "PUT", `/api/allocations/${ALLOC}`, {
      paymentId: PAY, gigId: GIG_1, amountCents: 10000,
    });
    const res = await api(U1, "PUT", `/api/payments/${PAY}`, {
      amountCents: 10000, clientId: null,
    });
    expect(res.status).toBe(200);
    expect((await getPayment(PAY)).clientId).toBeNull();
  });
});
