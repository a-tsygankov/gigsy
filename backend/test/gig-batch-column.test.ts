/// <reference types="@cloudflare/vitest-pool-workers" />
/**
 * The column itself: does gigs.batch_id round-trip through both doors,
 * and does the server store exactly what it is given?
 *
 * There is deliberately no invariant to test here, unlike
 * gig-parent-column.test.ts's sibling gig-parent-invariants.test.ts.
 * batch_id is a correlation id the WEBAPP mints (lib/gig-batch.ts) and
 * the server never interprets: nothing is shared or inherited between
 * siblings, no other row is looked up, and a batch of one is simply
 * NULL. The only things that can go wrong are the two things every
 * nullable column can get wrong — a door that drops the field, or a
 * door that hardcodes it — so that is what this file checks, on both
 * doors, the way the parent-column test learned to.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations, seedUser } from "./helpers/db.ts";
import { api } from "./helpers/api.ts";

const U1 = "gig-batch-column-user";
const ACME = "bc000000-0000-4000-8000-000000000001";
const BATCH_A = "bd000000-0000-4000-8000-00000000000a";
const BATCH_B = "bd000000-0000-4000-8000-00000000000b";

type GigBody = { batchId: string | null; dateTime: number | null };

beforeAll(async () => {
  await applyMigrations(env.DB);
  await seedUser(env.DB, U1);
  await api(U1, "PUT", `/api/clients/${ACME}`, { name: "Acme" });
});

describe("gigs.batch_id", () => {
  it("round-trips through the CRUD route", async () => {
    const id = "be000000-0000-4000-8000-000000000001";
    const res = await api(U1, "PUT", `/api/gigs/${id}`, {
      clientId: ACME,
      status: "lead",
      batchId: BATCH_A,
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as GigBody).batchId).toBe(BATCH_A);

    const read = await api(U1, "GET", `/api/gigs/${id}`);
    expect(((await read.json()) as GigBody).batchId).toBe(BATCH_A);
  });

  it("defaults to null for a gig created on its own", async () => {
    const id = "be000000-0000-4000-8000-000000000002";
    await api(U1, "PUT", `/api/gigs/${id}`, { clientId: ACME, status: "lead" });
    const read = await api(U1, "GET", `/api/gigs/${id}`);
    expect(((await read.json()) as GigBody).batchId).toBeNull();
  });

  // The sync door needs its own round-trip, for the reason
  // gig-parent-column.test.ts spells out: tsc catches the passthrough
  // in services/sync.ts being DELETED, since GigData.batchId is
  // required, but not its being MIS-WIRED to a constant. And this is
  // the door that matters most for THIS column: a batch is created in
  // one go from one form, which on an offline-first app means one
  // outbox drain carrying every sibling.
  it("three gigs posted in one /api/sync batch read back with one id", async () => {
    const ids = [
      "be000000-0000-4000-8000-000000000003",
      "be000000-0000-4000-8000-000000000004",
      "be000000-0000-4000-8000-000000000005",
    ];
    const res = await api(U1, "POST", "/api/sync", {
      ops: ids.map((id, i) => ({
        entity: "gig",
        op: "upsert",
        id,
        modifiedAt: 1000,
        payload: {
          clientId: ACME,
          status: "confirmed",
          dateTime: 1_700_000_000_000 + i * 86_400_000,
          batchId: BATCH_B,
        },
      })),
    });
    expect(res.status).toBe(200);
    const results = ((await res.json()) as { results: { status: string }[] }).results;
    expect(results.map((r) => r.status)).toEqual(["applied", "applied", "applied"]);

    for (const id of ids) {
      const read = await api(U1, "GET", `/api/gigs/${id}`);
      expect(((await read.json()) as GigBody).batchId).toBe(BATCH_B);
    }
  });

  // An edit is a full PUT, and the webapp's gigToInput carries batchId
  // forward untouched — so resending it must keep it. Sending null must
  // clear it, because the server stores what it is given and nothing
  // else: there is no "preserve when absent" rule here the way
  // repos/payments.ts has for clientId, and this test is what pins
  // that down.
  it("an edit that resends the id keeps it, and null clears it", async () => {
    const id = "be000000-0000-4000-8000-000000000006";
    await api(U1, "PUT", `/api/gigs/${id}`, {
      clientId: ACME,
      status: "lead",
      batchId: BATCH_A,
    });

    const kept = await api(U1, "PUT", `/api/gigs/${id}`, {
      clientId: ACME,
      status: "confirmed",
      batchId: BATCH_A,
    });
    expect(kept.status).toBe(200);
    expect(((await kept.json()) as GigBody).batchId).toBe(BATCH_A);

    const cleared = await api(U1, "PUT", `/api/gigs/${id}`, {
      clientId: ACME,
      status: "confirmed",
      batchId: null,
    });
    expect(cleared.status).toBe(200);
    expect(((await cleared.json()) as GigBody).batchId).toBeNull();

    const read = await api(U1, "GET", `/api/gigs/${id}`);
    expect(((await read.json()) as GigBody).batchId).toBeNull();
  });

  // entityId, like every other id in domain/schemas.ts: the webapp
  // mints it with crypto.randomUUID(), and anything else is a client
  // bug that should fail loudly rather than land as a string nothing
  // will ever group on.
  it("refuses a batchId that is not a UUID", async () => {
    const id = "be000000-0000-4000-8000-000000000007";
    const res = await api(U1, "PUT", `/api/gigs/${id}`, {
      clientId: ACME,
      status: "lead",
      batchId: "batch-1",
    });
    expect(res.status).toBe(400);
  });
});
