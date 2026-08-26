/// <reference types="@cloudflare/vitest-pool-workers" />
/**
 * The rules that keep parentGigId coherent, enforced identically at
 * both doors — PUT /api/gigs/:id and a sync "gig" op.
 *
 * Rule 3 (a parent may not itself have a parent) is doing more work
 * than it looks. It makes cycles unreachable: if A's parent is B then
 * B has none, so B cannot later adopt A. No traversal, no recursive
 * query, no cycle detection. The one cycle it does NOT catch is a gig
 * naming itself, which is why rule 4 exists separately.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations, seedUser } from "./helpers/db.ts";
import { api } from "./helpers/api.ts";

const U1 = "gig-parent-inv-user";
const U2 = "gig-parent-inv-other";
const ACME = "ca000000-0000-4000-8000-000000000001";
const BRAVO = "ca000000-0000-4000-8000-000000000002";

const TOP = "cb000000-0000-4000-8000-000000000001";      // Acme, no parent
const CHILD = "cb000000-0000-4000-8000-000000000002";    // Acme, parent TOP
const OTHER_CLIENT = "cb000000-0000-4000-8000-000000000003"; // Bravo
const NO_CLIENT_A = "cb000000-0000-4000-8000-000000000004";
const NO_CLIENT_B = "cb000000-0000-4000-8000-000000000005";
const FOREIGN = "cb000000-0000-4000-8000-000000000006";  // belongs to U2

/**
 * One sync op, through POST /api/sync.
 *
 * The wire field carrying a refusal message is `reason` (SyncOpResult
 * in services/sync.ts, asserted that way throughout test/sync.test.ts);
 * it is surfaced here as `error` so the assertions below read the same
 * way as the CRUD door's `{ error }` body. Same string either way —
 * that byte-identity is what these tests exist to pin down.
 */
async function syncGig(
  userId: string,
  id: string,
  payload: Record<string, unknown>,
): Promise<{ status: string; error?: string | undefined }> {
  const res = await api(userId, "POST", "/api/sync", {
    ops: [{ entity: "gig", op: "upsert", id, modifiedAt: Date.now(), payload }],
  });
  const body = (await res.json()) as {
    results: { id: string; status: string; reason?: string }[];
  };
  const result = body.results[0]!;
  return { status: result.status, error: result.reason };
}

beforeAll(async () => {
  await applyMigrations(env.DB);
  await seedUser(env.DB, U1);
  await seedUser(env.DB, U2);
  await api(U1, "PUT", `/api/clients/${ACME}`, { name: "Acme" });
  await api(U1, "PUT", `/api/clients/${BRAVO}`, { name: "Bravo" });

  await api(U1, "PUT", `/api/gigs/${TOP}`, { clientId: ACME, status: "confirmed" });
  await api(U1, "PUT", `/api/gigs/${CHILD}`, {
    clientId: ACME,
    status: "lead",
    parentGigId: TOP,
  });
  await api(U1, "PUT", `/api/gigs/${OTHER_CLIENT}`, { clientId: BRAVO, status: "lead" });
  await api(U1, "PUT", `/api/gigs/${NO_CLIENT_A}`, { status: "lead" });
  await api(U1, "PUT", `/api/gigs/${NO_CLIENT_B}`, { status: "lead" });
  await api(U2, "PUT", `/api/gigs/${FOREIGN}`, { status: "lead" });
});

describe("parent rules — CRUD route", () => {
  const NEW = "cc000000-0000-4000-8000-00000000000";

  it("refuses a parent that is not yours", async () => {
    const res = await api(U1, "PUT", `/api/gigs/${NEW}1`, {
      clientId: ACME,
      status: "lead",
      parentGigId: FOREIGN,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "parentGigId does not reference your gig",
    );
  });

  it("refuses a parent belonging to another client", async () => {
    const res = await api(U1, "PUT", `/api/gigs/${NEW}2`, {
      clientId: ACME,
      status: "lead",
      parentGigId: OTHER_CLIENT,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "parentGigId does not reference the same client",
    );
  });

  it("refuses a parent that already has a parent", async () => {
    const res = await api(U1, "PUT", `/api/gigs/${NEW}3`, {
      clientId: ACME,
      status: "lead",
      parentGigId: CHILD,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "parentGigId already has a parent of its own",
    );
  });

  it("refuses a gig naming itself", async () => {
    const res = await api(U1, "PUT", `/api/gigs/${NEW}4`, {
      clientId: ACME,
      status: "lead",
      parentGigId: `${NEW}4`,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "a gig cannot be its own parent",
    );
  });

  it("allows two client-less gigs to link", async () => {
    // Both null IS the same client. The rule is about coherence of the
    // client's history, and two unattributed gigs share that answer.
    const res = await api(U1, "PUT", `/api/gigs/${NEW}5`, {
      status: "lead",
      parentGigId: NO_CLIENT_A,
    });
    expect(res.status).toBeLessThan(300);
    expect(((await res.json()) as { parentGigId: string }).parentGigId).toBe(NO_CLIENT_A);
  });

  it("refuses a client-less child under a client's gig", async () => {
    const res = await api(U1, "PUT", `/api/gigs/${NEW}6`, {
      status: "lead",
      parentGigId: TOP,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "parentGigId does not reference the same client",
    );
  });
});

describe("parent rules — sync door, byte-identical messages", () => {
  const S = "cd000000-0000-4000-8000-00000000000";

  it("refuses a parent that is not yours", async () => {
    const r = await syncGig(U1, `${S}1`, {
      clientId: ACME,
      status: "lead",
      parentGigId: FOREIGN,
    });
    expect(r.status).toBe("error");
    expect(r.error).toBe("parentGigId does not reference your gig");
  });

  it("refuses a parent belonging to another client", async () => {
    const r = await syncGig(U1, `${S}2`, {
      clientId: ACME,
      status: "lead",
      parentGigId: OTHER_CLIENT,
    });
    expect(r.status).toBe("error");
    expect(r.error).toBe("parentGigId does not reference the same client");
  });

  it("refuses a parent that already has a parent", async () => {
    const r = await syncGig(U1, `${S}3`, {
      clientId: ACME,
      status: "lead",
      parentGigId: CHILD,
    });
    expect(r.status).toBe("error");
    expect(r.error).toBe("parentGigId already has a parent of its own");
  });

  it("refuses a gig naming itself", async () => {
    const r = await syncGig(U1, `${S}4`, {
      clientId: ACME,
      status: "lead",
      parentGigId: `${S}4`,
    });
    expect(r.status).toBe("error");
    expect(r.error).toBe("a gig cannot be its own parent");
  });

  it("accepts a legitimate link", async () => {
    const r = await syncGig(U1, `${S}5`, {
      clientId: ACME,
      status: "lead",
      parentGigId: TOP,
    });
    expect(r.status).not.toBe("error");
  });
});
