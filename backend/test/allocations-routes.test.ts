/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations, seedUser } from "./helpers/db.ts";
import { api } from "./helpers/api.ts";

const U1 = "user-1";
const U2 = "user-2";
const PAY = "44444444-dddd-4ddd-8ddd-444444444444";
const GIG_A = "11111111-aaaa-4aaa-8aaa-111111111111";
const GIG_B = "22222222-bbbb-4bbb-8bbb-222222222222";
const ALLOC_1 = "33333333-cccc-4ccc-8ccc-333333333333";
const ALLOC_2 = "55555555-eeee-4eee-8eee-555555555555";

const CLIENT_1 = "66666666-ffff-4fff-8fff-666666666666";
const CLIENT_2 = "77777777-1111-4111-8111-777777777777";
const GIG_C1 = "88888888-2222-4222-8222-888888888888";
const GIG_C2 = "99999999-3333-4333-8333-999999999999";
const PAY_C1 = "aaaaaaaa-4444-4444-8444-aaaaaaaaaaaa";
const PAY_NULL = "bbbbbbbb-5555-4555-8555-bbbbbbbbbbbb";
const ALLOC_C1 = "cccccccc-6666-4666-8666-cccccccccccc";
const ALLOC_MISMATCH = "dddddddd-7777-4777-8777-dddddddddddd";
const ALLOC_FREE_1 = "eeeeeeee-8888-4888-8888-eeeeeeeeeeee";
const ALLOC_FREE_2 = "ffffffff-9999-4999-8999-ffffffffffff";

const listFor = async (paymentId: string) =>
  ((await (await api(U1, "GET", `/api/allocations?paymentId=${paymentId}`)).json()) as {
    items: { id: string; gigId: string; amountCents: number }[];
  }).items;

const getGig = async (id: string) =>
  (await (await api(U1, "GET", `/api/gigs/${id}`)).json()) as {
    amountPaidCents: number | null;
  };

beforeEach(async () => {
  await applyMigrations(env.DB);
  await seedUser(env.DB, U1);
  await seedUser(env.DB, U2);
  await api(U1, "PUT", `/api/gigs/${GIG_A}`, { status: "completed", amountOfferedCents: 10000 });
  await api(U1, "PUT", `/api/gigs/${GIG_B}`, { status: "completed", amountOfferedCents: 5000 });
  await api(U1, "PUT", `/api/payments/${PAY}`, { amountCents: 10000 });
});

describe("allocation routes", () => {
  it("rejects a split larger than the payment", async () => {
    await api(U1, "PUT", `/api/allocations/${ALLOC_1}`, {
      paymentId: PAY, gigId: GIG_A, amountCents: 6000,
    });
    const second = await api(U1, "PUT", `/api/allocations/${ALLOC_2}`, {
      paymentId: PAY, gigId: GIG_B, amountCents: 6000,
    });
    expect(second.status).toBe(400);
  });

  it("allows a partial split and reports the remainder", async () => {
    await api(U1, "PUT", `/api/allocations/${ALLOC_1}`, {
      paymentId: PAY, gigId: GIG_A, amountCents: 6000,
    });
    const body = (await (await api(U1, "GET", `/api/payments/${PAY}`)).json()) as {
      allocatedCents: number;
      unallocatedCents: number;
    };
    expect(body.allocatedCents).toBe(6000);
    expect(body.unallocatedCents).toBe(4000);
  });

  it("updates the gig's derived paid total", async () => {
    await api(U1, "PUT", `/api/allocations/${ALLOC_1}`, {
      paymentId: PAY, gigId: GIG_A, amountCents: 6000,
    });
    expect((await getGig(GIG_A)).amountPaidCents).toBe(6000);
  });

  it("clears the total when the allocation goes", async () => {
    await api(U1, "PUT", `/api/allocations/${ALLOC_1}`, {
      paymentId: PAY, gigId: GIG_A, amountCents: 6000,
    });
    await api(U1, "DELETE", `/api/allocations/${ALLOC_1}`);
    expect((await getGig(GIG_A)).amountPaidCents).toBeNull();
  });

  it("refuses a gig that is not yours", async () => {
    const res = await api(U2, "PUT", `/api/allocations/${ALLOC_1}`, {
      paymentId: PAY, gigId: GIG_A, amountCents: 1000,
    });
    expect(res.status).toBe(400);
  });

  it("turns a legacy payment gigId into a single allocation", async () => {
    await api(U1, "PUT", `/api/payments/${PAY}`, { amountCents: 10000, gigId: GIG_A });
    const allocations = await listFor(PAY);
    expect(allocations).toHaveLength(1);
    expect(allocations[0]!.amountCents).toBe(10000);
    expect((await getGig(GIG_A)).amountPaidCents).toBe(10000);
  });

  it("does not double up when a legacy client re-sends the same payment", async () => {
    await api(U1, "PUT", `/api/payments/${PAY}`, { amountCents: 10000, gigId: GIG_A });
    await api(U1, "PUT", `/api/payments/${PAY}`, { amountCents: 10000, gigId: GIG_A });
    expect(await listFor(PAY)).toHaveLength(1);
  });

  it("moves the derived total off the previous gig when a legacy payment's gigId changes", async () => {
    await api(U1, "PUT", `/api/payments/${PAY}`, { amountCents: 10000, gigId: GIG_A });
    await api(U1, "PUT", `/api/payments/${PAY}`, { amountCents: 10000, gigId: GIG_B });
    expect((await getGig(GIG_A)).amountPaidCents).toBeNull();
    expect((await getGig(GIG_B)).amountPaidCents).toBe(10000);
  });

  describe("the client rule", () => {
    beforeEach(async () => {
      await api(U1, "PUT", `/api/clients/${CLIENT_1}`, { name: "Client One" });
      await api(U1, "PUT", `/api/clients/${CLIENT_2}`, { name: "Client Two" });
      await api(U1, "PUT", `/api/gigs/${GIG_C1}`, {
        status: "completed", amountOfferedCents: 10000, clientId: CLIENT_1,
      });
      await api(U1, "PUT", `/api/gigs/${GIG_C2}`, {
        status: "completed", amountOfferedCents: 10000, clientId: CLIENT_2,
      });
      await api(U1, "PUT", `/api/payments/${PAY_C1}`, {
        amountCents: 10000, clientId: CLIENT_1,
      });
      await api(U1, "PUT", `/api/payments/${PAY_NULL}`, { amountCents: 10000 });
    });

    it("refuses an allocation to another client's gig", async () => {
      const res = await api(U1, "PUT", `/api/allocations/${ALLOC_MISMATCH}`, {
        paymentId: PAY_C1, gigId: GIG_C2, amountCents: 1000,
      });
      expect(res.status).toBe(400);
      expect(await listFor(PAY_C1)).toHaveLength(0);
    });

    it("accepts an allocation to the payment's own client's gig", async () => {
      const res = await api(U1, "PUT", `/api/allocations/${ALLOC_C1}`, {
        paymentId: PAY_C1, gigId: GIG_C1, amountCents: 1000,
      });
      expect(res.status).toBe(201);
      expect(await listFor(PAY_C1)).toHaveLength(1);
    });

    it("lets a null-client payment allocate freely across clients", async () => {
      const first = await api(U1, "PUT", `/api/allocations/${ALLOC_FREE_1}`, {
        paymentId: PAY_NULL, gigId: GIG_C1, amountCents: 1000,
      });
      const second = await api(U1, "PUT", `/api/allocations/${ALLOC_FREE_2}`, {
        paymentId: PAY_NULL, gigId: GIG_C2, amountCents: 1000,
      });
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(await listFor(PAY_NULL)).toHaveLength(2);
    });
  });
});
