/// <reference types="@cloudflare/vitest-pool-workers" />
/**
 * The column itself: does it round-trip, and does D1 honour
 * ON DELETE SET NULL?
 *
 * The second question is the reason this file exists. 0015's header
 * records this D1 instance accepting and silently ignoring
 * `PRAGMA foreign_keys=off`, so "the DDL was accepted" is not evidence
 * the action runs. If the last test here fails, the migration's own
 * header names the fallback: clear children explicitly in
 * GigsRepo.remove.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations, seedUser } from "./helpers/db.ts";
import { api } from "./helpers/api.ts";

const U1 = "gig-parent-column-user";
const ACME = "ba000000-0000-4000-8000-000000000001";
const PARENT = "bb000000-0000-4000-8000-000000000001";
const CHILD = "bb000000-0000-4000-8000-000000000002";

beforeAll(async () => {
  await applyMigrations(env.DB);
  await seedUser(env.DB, U1);
  await api(U1, "PUT", `/api/clients/${ACME}`, { name: "Acme" });
});

describe("gigs.parent_gig_id", () => {
  it("round-trips through the CRUD route", async () => {
    await api(U1, "PUT", `/api/gigs/${PARENT}`, {
      clientId: ACME,
      status: "confirmed",
    });
    const res = await api(U1, "PUT", `/api/gigs/${CHILD}`, {
      clientId: ACME,
      status: "lead",
      parentGigId: PARENT,
    });
    expect(res.status).toBeLessThan(300);
    const body = (await res.json()) as { parentGigId: string | null };
    expect(body.parentGigId).toBe(PARENT);

    const read = await api(U1, "GET", `/api/gigs/${CHILD}`);
    const got = (await read.json()) as { parentGigId: string | null };
    expect(got.parentGigId).toBe(PARENT);
  });

  it("defaults to null for a gig that is part of nothing", async () => {
    const id = "bb000000-0000-4000-8000-000000000003";
    await api(U1, "PUT", `/api/gigs/${id}`, { clientId: ACME, status: "lead" });
    const read = await api(U1, "GET", `/api/gigs/${id}`);
    const got = (await read.json()) as { parentGigId: string | null };
    expect(got.parentGigId).toBeNull();
  });

  it("keeps the child alive with a null link when its parent is deleted", async () => {
    // The question this file exists for. If this fails, D1 accepted the
    // ON DELETE SET NULL clause without honouring it, and the fallback
    // is to clear children explicitly in GigsRepo.remove.
    const p = "bb000000-0000-4000-8000-000000000004";
    const c = "bb000000-0000-4000-8000-000000000005";
    await api(U1, "PUT", `/api/gigs/${p}`, { clientId: ACME, status: "confirmed" });
    await api(U1, "PUT", `/api/gigs/${c}`, {
      clientId: ACME,
      status: "lead",
      parentGigId: p,
    });

    const del = await api(U1, "DELETE", `/api/gigs/${p}`);
    expect(del.status).toBe(204);

    const read = await api(U1, "GET", `/api/gigs/${c}`);
    expect(read.status).toBe(200);
    const got = (await read.json()) as { parentGigId: string | null };
    expect(got.parentGigId).toBeNull();
  });

  // The sync door needs its own round-trip. tsc catches DELETING the
  // passthrough in services/sync.ts, because GigData.parentGigId is
  // required — but it cannot catch the line being MIS-WIRED, and
  // replacing it with a hardcoded null left all of sync.test.ts,
  // gigs-routes.test.ts and the tests above green. This is an
  // offline-first app: /api/sync carries most writes, so the door the
  // CRUD tests do not touch is the one that matters most.
  it("round-trips through the /api/sync batch", async () => {
    const p = "bb000000-0000-4000-8000-000000000006";
    const c = "bb000000-0000-4000-8000-000000000007";
    await api(U1, "POST", "/api/sync", { ops: [
      { entity: "gig", op: "upsert", id: p, modifiedAt: 1000,
        payload: { clientId: ACME, status: "confirmed" } },
      { entity: "gig", op: "upsert", id: c, modifiedAt: 1000,
        payload: { clientId: ACME, status: "lead", parentGigId: p } },
    ]});
    const read = await api(U1, "GET", `/api/gigs/${c}`);
    expect(((await read.json()) as { parentGigId: string | null }).parentGigId).toBe(p);
  });
});
