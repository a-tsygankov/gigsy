/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeAll } from "vitest";
import { SELF, env } from "cloudflare:test";
import { applyMigrations, seedUser } from "./helpers/db.ts";
import { api } from "./helpers/api.ts";

const U1 = "user-1";
const U2 = "user-2";
const CID = "77777777-7777-4777-8777-777777777777";
const GID = "88888888-8888-4888-8888-888888888888";
const EID = "99999999-9999-4999-8999-999999999999";

type SyncResult = { id: string; status: string; reason?: string };
type SyncResponse = { results: SyncResult[] };

beforeAll(async () => {
  await applyMigrations(env.DB);
  await seedUser(env.DB, U1);
  await seedUser(env.DB, U2);
});

async function sync(userId: string, ops: unknown[]): Promise<SyncResponse> {
  const res = await api(userId, "POST", "/api/sync", { ops });
  expect(res.status).toBe(200);
  return (await res.json()) as SyncResponse;
}

describe("POST /api/sync", () => {
  it("401s without a token", async () => {
    const res = await SELF.fetch("https://localhost/api/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ops: [] }),
    });
    expect(res.status).toBe(401);
  });

  it("applies a mixed-entity batch in order", async () => {
    const body = await sync(U1, [
      {
        entity: "client",
        op: "upsert",
        id: CID,
        modifiedAt: 1000,
        payload: { name: "Acme" },
      },
      {
        entity: "gig",
        op: "upsert",
        id: GID,
        modifiedAt: 1000,
        payload: { clientId: CID, status: "confirmed" },
      },
      {
        entity: "expense",
        op: "upsert",
        id: EID,
        modifiedAt: 1000,
        payload: { gigId: GID, amountCents: 500 },
      },
    ]);
    expect(body.results.map((r) => r.status)).toEqual([
      "applied",
      "applied",
      "applied",
    ]);

    const gig = (await (await api(U1, "GET", `/api/gigs/${GID}`)).json()) as {
      clientId: string;
      modifiedAt: number;
    };
    expect(gig.clientId).toBe(CID);
    expect(gig.modifiedAt).toBe(1000);
  });

  it("is idempotent on replay — no duplicate rows", async () => {
    const ops = [
      {
        entity: "client",
        op: "upsert",
        id: CID,
        modifiedAt: 1000,
        payload: { name: "Acme" },
      },
    ];
    await sync(U1, ops);
    const replay = await sync(U1, ops);
    expect(replay.results[0]?.status).toBe("applied");

    const list = (await (await api(U1, "GET", "/api/clients")).json()) as {
      items: unknown[];
    };
    expect(list.items).toHaveLength(1);
  });

  it("skips a stale op (LWW by modifiedAt)", async () => {
    await sync(U1, [
      {
        entity: "client",
        op: "upsert",
        id: CID,
        modifiedAt: 2000,
        payload: { name: "Newer" },
      },
    ]);
    const body = await sync(U1, [
      {
        entity: "client",
        op: "upsert",
        id: CID,
        modifiedAt: 1000,
        payload: { name: "Older" },
      },
    ]);
    expect(body.results[0]?.status).toBe("skipped");
    expect(body.results[0]?.reason).toContain("stale");

    const record = (await (
      await api(U1, "GET", `/api/clients/${CID}`)
    ).json()) as { name: string; modifiedAt: number };
    expect(record.name).toBe("Newer");
    expect(record.modifiedAt).toBe(2000);
  });

  it("applies the newer op over an older row", async () => {
    await sync(U1, [
      {
        entity: "client",
        op: "upsert",
        id: CID,
        modifiedAt: 1000,
        payload: { name: "Old" },
      },
    ]);
    await sync(U1, [
      {
        entity: "client",
        op: "upsert",
        id: CID,
        modifiedAt: 3000,
        payload: { name: "New" },
      },
    ]);
    const record = (await (
      await api(U1, "GET", `/api/clients/${CID}`)
    ).json()) as { name: string; modifiedAt: number };
    expect(record.name).toBe("New");
    expect(record.modifiedAt).toBe(3000);
  });

  it("errors on another user's row without aborting the batch", async () => {
    await sync(U1, [
      {
        entity: "client",
        op: "upsert",
        id: CID,
        modifiedAt: 1000,
        payload: { name: "Mine" },
      },
    ]);
    const OTHER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const body = await sync(U2, [
      {
        entity: "client",
        op: "upsert",
        id: CID,
        modifiedAt: 9000,
        payload: { name: "Steal" },
      },
      {
        entity: "client",
        op: "upsert",
        id: OTHER,
        modifiedAt: 1000,
        payload: { name: "Legit" },
      },
    ]);
    expect(body.results[0]?.status).toBe("error");
    expect(body.results[1]?.status).toBe("applied");

    const mine = (await (
      await api(U1, "GET", `/api/clients/${CID}`)
    ).json()) as { name: string };
    expect(mine.name).toBe("Mine");
  });

  it("errors per-op on an invalid payload", async () => {
    const body = await sync(U1, [
      {
        entity: "client",
        op: "upsert",
        id: CID,
        modifiedAt: 1000,
        payload: { name: "" },
      },
    ]);
    expect(body.results[0]?.status).toBe("error");
  });

  it("errors on a gig link to a client the caller does not own", async () => {
    await sync(U2, [
      {
        entity: "client",
        op: "upsert",
        id: CID,
        modifiedAt: 1000,
        payload: { name: "Theirs" },
      },
    ]);
    const body = await sync(U1, [
      {
        entity: "gig",
        op: "upsert",
        id: GID,
        modifiedAt: 1000,
        payload: { clientId: CID },
      },
    ]);
    expect(body.results[0]?.status).toBe("error");
  });

  it("applies deletes; deleting a missing row is skipped", async () => {
    await sync(U1, [
      {
        entity: "client",
        op: "upsert",
        id: CID,
        modifiedAt: 1000,
        payload: { name: "Acme" },
      },
    ]);
    const body = await sync(U1, [
      { entity: "client", op: "delete", id: CID, modifiedAt: 2000 },
      { entity: "client", op: "delete", id: CID, modifiedAt: 3000 },
    ]);
    expect(body.results.map((r) => r.status)).toEqual(["applied", "skipped"]);
    expect((await api(U1, "GET", `/api/clients/${CID}`)).status).toBe(404);
  });

  // The webapp never calls PUT /api/gigs/:id — it queues an outbox op
  // and posts here, through a hand-written upsert object that has to
  // list every column by name. Dropping a field from that list is how
  // this repo lost every gig duration for months.
  it("carries a gig title through the upsert", async () => {
    const TITLED = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const body = await sync(U1, [
      {
        entity: "gig",
        op: "upsert",
        id: TITLED,
        modifiedAt: 5000,
        payload: { title: "Costco tasting", status: "lead" },
      },
    ]);
    expect(body.results[0]?.status).toBe("applied");

    const gig = (await (await api(U1, "GET", `/api/gigs/${TITLED}`)).json()) as {
      title: string | null;
    };
    expect(gig.title).toBe("Costco tasting");
  });

  // Same failure mode as the title test above, but for the pay/work-log
  // fields added alongside it — the hand-written upsert object in
  // sync.ts has to list these five by name too.
  it("carries hourly pay and work-log fields through the upsert", async () => {
    const PAID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const body = await sync(U1, [
      {
        entity: "gig",
        op: "upsert",
        id: PAID,
        modifiedAt: 5000,
        payload: {
          status: "confirmed",
          payType: "hourly",
          hourlyRateCents: 3000,
          workStartedAt: 1_000_000_000,
          workEndedAt: 1_000_000_000 + 4 * 3_600_000,
          breakMinutes: 30,
        },
      },
    ]);
    expect(body.results[0]?.status).toBe("applied");

    const gig = (await (await api(U1, "GET", `/api/gigs/${PAID}`)).json()) as {
      payType: string;
      hourlyRateCents: number | null;
      workStartedAt: number | null;
      workEndedAt: number | null;
      breakMinutes: number | null;
    };
    expect(gig.payType).toBe("hourly");
    expect(gig.hourlyRateCents).toBe(3000);
    expect(gig.workStartedAt).toBe(1_000_000_000);
    expect(gig.workEndedAt).toBe(1_000_000_000 + 4 * 3_600_000);
    expect(gig.breakMinutes).toBe(30);
  });

  // C2 (code review, 2026-08-19): amountPaidCents is server-derived
  // (services/paid-totals.ts) since Phase 4's payment allocations.
  // GigInput has no such key, so a sync "gig" op that still sends one
  // has it silently dropped, same as the direct route
  // (gigs-routes.test.ts's "ignores a client-supplied amountPaidCents").
  it("ignores a client-supplied amountPaidCents on a gig sync op", async () => {
    const GID3 = "cccccccc-1111-4111-8111-cccccccccccc";
    const body = await sync(U1, [
      {
        entity: "gig",
        op: "upsert",
        id: GID3,
        modifiedAt: 1,
        payload: { status: "completed", amountPaidCents: 999_999 },
      },
    ]);
    expect(body.results[0]?.status).toBe("applied");

    const gig = (await (await api(U1, "GET", `/api/gigs/${GID3}`)).json()) as {
      amountPaidCents: number | null;
    };
    expect(gig.amountPaidCents).toBeNull();
  });

  it("400s on a malformed batch", async () => {
    const res = await api(U1, "POST", "/api/sync", { ops: [{ entity: "cat" }] });
    expect(res.status).toBe(400);
  });

  // C2: payment_allocations.payment_id references payments(id) with no
  // ON DELETE CASCADE. Before this fix, deleting a payment through
  // /api/sync while it still had allocations (true of every legacy
  // payment after migration 0016's backfill) failed the delete's own
  // FOREIGN KEY constraint and left the gig's derived total stale.
  //
  // The payment upsert's own legacy gigId translation (Task 4) is what
  // produces the allocation here now — see the "allocation" describe
  // block below for tests targeting that translation directly.
  it("deletes a payment's allocations first, so the delete succeeds and the gig total clears", async () => {
    const GID2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const PID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    await sync(U1, [
      { entity: "gig", op: "upsert", id: GID2, modifiedAt: 1, payload: { status: "completed" } },
      {
        entity: "payment",
        op: "upsert",
        id: PID,
        modifiedAt: 1,
        payload: { amountCents: 6000, gigId: GID2 },
      },
    ]);
    expect((await (await api(U1, "GET", `/api/gigs/${GID2}`)).json() as {
      amountPaidCents: number | null;
    }).amountPaidCents).toBe(6000);

    const body = await sync(U1, [
      { entity: "payment", op: "delete", id: PID, modifiedAt: 2 },
    ]);
    expect(body.results[0]?.status).toBe("applied");
    expect((await api(U1, "GET", `/api/payments/${PID}`)).status).toBe(404);
    expect((await (await api(U1, "GET", `/api/gigs/${GID2}`)).json() as {
      amountPaidCents: number | null;
    }).amountPaidCents).toBeNull();
  });

  // Phase 4 Task 4: allocations as the sixth sync entity.
  describe("\"allocation\" entity", () => {
    const GID3 = "11111111-1111-4111-8111-111111111111";
    const PID3 = "22222222-2222-4222-8222-222222222222";
    const AID3 = "33333333-3333-4333-8333-333333333333";
    const STRANGERS_GID = "44444444-4444-4444-8444-444444444444";

    beforeAll(async () => {
      await sync(U1, [
        { entity: "gig", op: "upsert", id: GID3, modifiedAt: 1, payload: { status: "completed" } },
        { entity: "payment", op: "upsert", id: PID3, modifiedAt: 1, payload: { amountCents: 10000 } },
      ]);
      await sync(U2, [
        {
          entity: "gig",
          op: "upsert",
          id: STRANGERS_GID,
          modifiedAt: 1,
          payload: { status: "completed" },
        },
      ]);
    });

    it("round-trips an allocation and updates the gig total", async () => {
      const res = await api(U1, "POST", "/api/sync", {
        ops: [
          {
            entity: "allocation",
            op: "upsert",
            id: AID3,
            modifiedAt: 1,
            payload: { paymentId: PID3, gigId: GID3, amountCents: 5000 },
          },
        ],
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as SyncResponse;
      expect(body.results[0]?.status).toBe("applied");

      const gig = (await (await api(U1, "GET", `/api/gigs/${GID3}`)).json()) as {
        amountPaidCents: number | null;
      };
      expect(gig.amountPaidCents).toBe(5000);
    });

    it("rejects an allocation against someone else's gig", async () => {
      const res = await api(U1, "POST", "/api/sync", {
        ops: [
          {
            entity: "allocation",
            op: "upsert",
            id: "55555555-5555-4555-8555-555555555555",
            modifiedAt: 1,
            payload: { paymentId: PID3, gigId: STRANGERS_GID, amountCents: 1000 },
          },
        ],
      });
      const body = (await res.json()) as SyncResponse;
      expect(body.results[0]?.status).toBe("error");
      expect(body.results[0]?.reason).toMatch(/does not reference your gig/);
    });

    it("recomputes the total when an allocation is deleted", async () => {
      await sync(U1, [
        { entity: "allocation", op: "delete", id: AID3, modifiedAt: 2 },
      ]);
      const gig = (await (await api(U1, "GET", `/api/gigs/${GID3}`)).json()) as {
        amountPaidCents: number | null;
      };
      expect(gig.amountPaidCents).toBeNull();
    });
  });

  // Phase 4 Task 4: the "payment" case's gigId compat translation, drained
  // through the offline outbox path rather than a direct route write.
  describe("legacy payment gigId, translated through sync", () => {
    const GID4 = "66666666-6666-4666-8666-666666666666";
    const PID4 = "77777777-7777-4777-8777-777777777777";

    const listAllocations = async (paymentId: string) =>
      ((await (
        await api(U1, "GET", `/api/allocations?paymentId=${paymentId}`)
      ).json()) as { items: { amountCents: number; gigId: string }[] }).items;

    beforeAll(async () => {
      await sync(U1, [
        { entity: "gig", op: "upsert", id: GID4, modifiedAt: 1, payload: { status: "completed" } },
      ]);
    });

    it("produces exactly one allocation for a legacy payment op carrying gigId", async () => {
      await sync(U1, [
        {
          entity: "payment",
          op: "upsert",
          id: PID4,
          modifiedAt: 1,
          payload: { amountCents: 7000, gigId: GID4 },
        },
      ]);
      const allocations = await listAllocations(PID4);
      expect(allocations).toHaveLength(1);
      expect(allocations[0]).toMatchObject({ amountCents: 7000, gigId: GID4 });
      const gig = (await (await api(U1, "GET", `/api/gigs/${GID4}`)).json()) as {
        amountPaidCents: number | null;
      };
      expect(gig.amountPaidCents).toBe(7000);
    });

    it("does not produce a second allocation when the same op is replayed", async () => {
      await sync(U1, [
        {
          entity: "payment",
          op: "upsert",
          id: PID4,
          modifiedAt: 1,
          payload: { amountCents: 7000, gigId: GID4 },
        },
      ]);
      expect(await listAllocations(PID4)).toHaveLength(1);
    });
  });

  // Code review on Task 4 (2026-08-19): services/payment-invariants.ts
  // is what routes/allocations.ts and routes/payments.ts already had
  // their own tests for, but the sync path — the door this task adds —
  // had none of its own for these six things, despite sharing the same
  // checks. A gap in the shared module is a gap at both doors; a test
  // at only one door would not have caught it.
  describe("payment and allocation invariants, carried into sync", () => {
    const CLIENT_A = "60000000-0000-4000-8000-00000000000a";
    const CLIENT_B = "60000000-0000-4000-8000-00000000000b";
    const GIG_A = "61111111-1111-4111-8111-111111111111";
    const GIG_B = "62222222-2222-4222-8222-222222222222";

    beforeAll(async () => {
      await sync(U1, [
        { entity: "client", op: "upsert", id: CLIENT_A, modifiedAt: 1, payload: { name: "A" } },
        { entity: "client", op: "upsert", id: CLIENT_B, modifiedAt: 1, payload: { name: "B" } },
        {
          entity: "gig", op: "upsert", id: GIG_A, modifiedAt: 1,
          payload: { clientId: CLIENT_A, status: "completed" },
        },
        {
          entity: "gig", op: "upsert", id: GIG_B, modifiedAt: 1,
          payload: { clientId: CLIENT_B, status: "completed" },
        },
      ]);
    });

    it("over-allocation: rejects a split that would push the total past the payment", async () => {
      const PID = "63000000-0000-4000-8000-0000000000a1";
      await sync(U1, [
        { entity: "payment", op: "upsert", id: PID, modifiedAt: 1, payload: { amountCents: 10000 } },
        {
          entity: "allocation", op: "upsert", id: "63000000-0000-4000-8000-0000000000a2",
          modifiedAt: 1, payload: { paymentId: PID, gigId: GIG_A, amountCents: 6000 },
        },
      ]);
      const res = await api(U1, "POST", "/api/sync", {
        ops: [
          {
            entity: "allocation", op: "upsert", id: "63000000-0000-4000-8000-0000000000a3",
            modifiedAt: 1, payload: { paymentId: PID, gigId: GIG_A, amountCents: 5000 },
          },
        ],
      });
      const body = (await res.json()) as SyncResponse;
      expect(body.results[0]?.status).toBe("error");
      expect(body.results[0]?.reason).toMatch(/allocations exceed the payment/);
    });

    it("the client rule: rejects an allocation to a gig outside the payment's client", async () => {
      const PID = "63000000-0000-4000-8000-0000000000b1";
      await sync(U1, [
        {
          entity: "payment", op: "upsert", id: PID, modifiedAt: 1,
          payload: { amountCents: 10000, clientId: CLIENT_A },
        },
      ]);
      const res = await api(U1, "POST", "/api/sync", {
        ops: [
          {
            entity: "allocation", op: "upsert", id: "63000000-0000-4000-8000-0000000000b2",
            modifiedAt: 1, payload: { paymentId: PID, gigId: GIG_B, amountCents: 1000 },
          },
        ],
      });
      const body = (await res.json()) as SyncResponse;
      expect(body.results[0]?.status).toBe("error");
      expect(body.results[0]?.reason).toBe("gigId does not reference the payment's client");
    });

    it("I4: refuses to shrink a payment below what is already allocated to it", async () => {
      const PID = "63000000-0000-4000-8000-0000000000c1";
      await sync(U1, [
        { entity: "payment", op: "upsert", id: PID, modifiedAt: 1, payload: { amountCents: 10000 } },
        {
          entity: "allocation", op: "upsert", id: "63000000-0000-4000-8000-0000000000c2",
          modifiedAt: 1, payload: { paymentId: PID, gigId: GIG_A, amountCents: 6000 },
        },
      ]);
      const res = await api(U1, "POST", "/api/sync", {
        ops: [
          { entity: "payment", op: "upsert", id: PID, modifiedAt: 2, payload: { amountCents: 5000 } },
        ],
      });
      const body = (await res.json()) as SyncResponse;
      expect(body.results[0]?.status).toBe("error");
      expect(body.results[0]?.reason).toMatch(
        /amountCents is less than the payment's allocated total/,
      );
    });

    it("I5: refuses a clientId change that would strand allocations on another client's gigs", async () => {
      const PID = "63000000-0000-4000-8000-0000000000d1";
      await sync(U1, [
        {
          entity: "payment", op: "upsert", id: PID, modifiedAt: 1,
          payload: { amountCents: 10000, clientId: CLIENT_A },
        },
        {
          entity: "allocation", op: "upsert", id: "63000000-0000-4000-8000-0000000000d2",
          modifiedAt: 1, payload: { paymentId: PID, gigId: GIG_A, amountCents: 4000 },
        },
      ]);
      const res = await api(U1, "POST", "/api/sync", {
        ops: [
          {
            entity: "payment", op: "upsert", id: PID, modifiedAt: 2,
            payload: { amountCents: 10000, clientId: CLIENT_B },
          },
        ],
      });
      const body = (await res.json()) as SyncResponse;
      expect(body.results[0]?.status).toBe("error");
      expect(body.results[0]?.reason).toMatch(
        /clientId does not match one or more gigs this payment is already allocated to/,
      );
    });

    it("staleness: an older allocation op is skipped rather than applied", async () => {
      const PID = "63000000-0000-4000-8000-0000000000e1";
      const AID = "63000000-0000-4000-8000-0000000000e2";
      await sync(U1, [
        { entity: "payment", op: "upsert", id: PID, modifiedAt: 1, payload: { amountCents: 10000 } },
        {
          entity: "allocation", op: "upsert", id: AID, modifiedAt: 100,
          payload: { paymentId: PID, gigId: GIG_A, amountCents: 3000 },
        },
      ]);
      const res = await api(U1, "POST", "/api/sync", {
        ops: [
          {
            entity: "allocation", op: "upsert", id: AID, modifiedAt: 50,
            payload: { paymentId: PID, gigId: GIG_A, amountCents: 9000 },
          },
        ],
      });
      const body = (await res.json()) as SyncResponse;
      expect(body.results[0]?.status).toBe("skipped");
      const allocation = (await (
        await api(U1, "GET", `/api/allocations/${AID}`)
      ).json()) as { amountCents: number };
      expect(allocation.amountCents).toBe(3000);
    });

    // C1 (code review, 2026-08-19): the actual regression test for the
    // bug this whole review round exists for. The old gig must clear
    // even though it isn't the gig THIS op names, because the row that
    // used to hold its allocation just moved to a different payment,
    // not just a different gig.
    it("C1: moving an allocation to a different payment AND gig recomputes the gig it left", async () => {
      const GIG_FROM = "64000000-0000-4000-8000-000000000001";
      const GIG_TO = "64000000-0000-4000-8000-000000000002";
      const PID_FROM = "64000000-0000-4000-8000-000000000003";
      const PID_TO = "64000000-0000-4000-8000-000000000004";
      const AID = "64000000-0000-4000-8000-000000000005";
      await sync(U1, [
        { entity: "gig", op: "upsert", id: GIG_FROM, modifiedAt: 1, payload: { status: "completed" } },
        { entity: "gig", op: "upsert", id: GIG_TO, modifiedAt: 1, payload: { status: "completed" } },
        { entity: "payment", op: "upsert", id: PID_FROM, modifiedAt: 1, payload: { amountCents: 5000 } },
        { entity: "payment", op: "upsert", id: PID_TO, modifiedAt: 1, payload: { amountCents: 5000 } },
        {
          entity: "allocation", op: "upsert", id: AID, modifiedAt: 1,
          payload: { paymentId: PID_FROM, gigId: GIG_FROM, amountCents: 3000 },
        },
      ]);

      const getGig = async (id: string) =>
        (await (await api(U1, "GET", `/api/gigs/${id}`)).json()) as {
          amountPaidCents: number | null;
        };
      expect((await getGig(GIG_FROM)).amountPaidCents).toBe(3000);
      expect((await getGig(GIG_TO)).amountPaidCents).toBeNull();

      // Same allocation id; both paymentId AND gigId change in one op.
      const body = await sync(U1, [
        {
          entity: "allocation", op: "upsert", id: AID, modifiedAt: 2,
          payload: { paymentId: PID_TO, gigId: GIG_TO, amountCents: 3000 },
        },
      ]);
      expect(body.results[0]?.status).toBe("applied");

      // The bug: deriving "which gig to recompute" from the list of
      // allocations already on the NEW payment — always empty for a
      // row that just arrived from somewhere else — instead of from
      // the allocation's own row as it stood before the write. Without
      // the fix, GIG_FROM keeps reporting 3000 paid with no allocation
      // left to back it, and the 3000 is double-counted against GIG_TO.
      expect((await getGig(GIG_FROM)).amountPaidCents).toBeNull();
      expect((await getGig(GIG_TO)).amountPaidCents).toBe(3000);
    });
  });

  // The legacy `gigId` compat path must not be able to collapse a
  // payment that is already split across several gigs. Every shipped
  // webapp build predates allocations and puts `gigId` on EVERY payment
  // write, so without this guard a note edit queued on an un-updated
  // device silently reassigns the whole payment to one gig — the split
  // rows deleted, the other gigs' derived totals dropping to null.
  //
  // Asserted straight out of D1 rather than through /api/allocations or
  // /api/gigs: the point is what is actually stored, not what a read
  // route recomputes on the way out.
  describe("a legacy payment gigId must not destroy an existing split", () => {
    const GIG_A = "65000000-0000-4000-8000-00000000000a";
    const GIG_B = "65000000-0000-4000-8000-00000000000b";
    const PID = "65000000-0000-4000-8000-00000000000c";
    const ALLOC_A = "65000000-0000-4000-8000-00000000000d";
    const ALLOC_B = "65000000-0000-4000-8000-00000000000e";

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

    /** A 10000 payment split 4000/3000 across two gigs, exactly the
     *  shape the split-payment UI is about to start producing. */
    async function seedSplit(): Promise<void> {
      await sync(U1, [
        { entity: "gig", op: "upsert", id: GIG_A, modifiedAt: 1, payload: { status: "completed" } },
        { entity: "gig", op: "upsert", id: GIG_B, modifiedAt: 1, payload: { status: "completed" } },
        { entity: "payment", op: "upsert", id: PID, modifiedAt: 1, payload: { amountCents: 10000 } },
        {
          entity: "allocation", op: "upsert", id: ALLOC_A, modifiedAt: 1,
          payload: { paymentId: PID, gigId: GIG_A, amountCents: 4000 },
        },
        {
          entity: "allocation", op: "upsert", id: ALLOC_B, modifiedAt: 1,
          payload: { paymentId: PID, gigId: GIG_B, amountCents: 3000 },
        },
      ]);
      expect(await allocationRows(PID)).toHaveLength(2);
      expect(await paidCents(GIG_A)).toBe(4000);
      expect(await paidCents(GIG_B)).toBe(3000);
    }

    it("leaves both allocations and both derived totals untouched", async () => {
      await seedSplit();

      // The un-updated device's outbox op: an ordinary payment edit
      // that happens to carry the legacy gigId, naming only one of the
      // two gigs the money is actually split across.
      const body = await sync(U1, [
        {
          entity: "payment", op: "upsert", id: PID, modifiedAt: 2,
          payload: { amountCents: 10000, gigId: GIG_A, notes: "edited offline" },
        },
      ]);
      expect(body.results[0]?.status).toBe("applied");

      // The payment edit itself still lands — only the allocations are
      // off limits.
      const payment = await env.DB.prepare("SELECT notes FROM payments WHERE id = ?")
        .bind(PID)
        .first<{ notes: string | null }>();
      expect(payment?.notes).toBe("edited offline");

      expect(await allocationRows(PID)).toEqual([
        { gigId: GIG_A, amountCents: 4000 },
        { gigId: GIG_B, amountCents: 3000 },
      ]);
      expect(await paidCents(GIG_A)).toBe(4000);
      expect(await paidCents(GIG_B)).toBe(3000);
    });

    // I4 (payment-invariants.ts) is skipped on the compat path because
    // that path used to resize every allocation to the new amount. It
    // no longer does when a split is preserved, so the shrink refusal
    // has to come back — otherwise a legacy op could leave 7000
    // allocated against a 5000 payment.
    it("refuses a legacy op that would shrink the payment below the preserved split", async () => {
      await seedSplit();

      const res = await api(U1, "POST", "/api/sync", {
        ops: [
          {
            entity: "payment", op: "upsert", id: PID, modifiedAt: 2,
            payload: { amountCents: 5000, gigId: GIG_A },
          },
        ],
      });
      const body = (await res.json()) as SyncResponse;
      expect(body.results[0]?.status).toBe("error");
      expect(body.results[0]?.reason).toMatch(
        /amountCents is less than the payment's allocated total/,
      );

      const amount = await env.DB.prepare(
        "SELECT amount_cents AS amountCents FROM payments WHERE id = ?",
      )
        .bind(PID)
        .first<{ amountCents: number }>();
      expect(amount?.amountCents).toBe(10000);
      expect(await allocationRows(PID)).toHaveLength(2);
    });

    // The other half of the contract: one allocation is the ordinary
    // legacy shape and must keep behaving exactly as it does today —
    // replaced in place, moved to whatever gig the payload names.
    it("still replaces a lone allocation, including moving it to another gig", async () => {
      await sync(U1, [
        { entity: "gig", op: "upsert", id: GIG_A, modifiedAt: 1, payload: { status: "completed" } },
        { entity: "gig", op: "upsert", id: GIG_B, modifiedAt: 1, payload: { status: "completed" } },
        { entity: "payment", op: "upsert", id: PID, modifiedAt: 1, payload: { amountCents: 10000 } },
        {
          entity: "allocation", op: "upsert", id: ALLOC_A, modifiedAt: 1,
          payload: { paymentId: PID, gigId: GIG_A, amountCents: 4000 },
        },
      ]);

      await sync(U1, [
        {
          entity: "payment", op: "upsert", id: PID, modifiedAt: 2,
          payload: { amountCents: 9000, gigId: GIG_B },
        },
      ]);

      expect(await allocationRows(PID)).toEqual([
        { gigId: GIG_B, amountCents: 9000 },
      ]);
      expect(await paidCents(GIG_A)).toBeNull();
      expect(await paidCents(GIG_B)).toBe(9000);
    });
  });
});
