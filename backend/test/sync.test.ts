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

  it("400s on a malformed batch", async () => {
    const res = await api(U1, "POST", "/api/sync", { ops: [{ entity: "cat" }] });
    expect(res.status).toBe(400);
  });
});
