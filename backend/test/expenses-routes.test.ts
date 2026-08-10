/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations, seedUser } from "./helpers/db.ts";
import { api } from "./helpers/api.ts";

const U1 = "user-1";
const U2 = "user-2";
const E1 = "55555555-5555-4555-8555-555555555555";
const GIG = "66666666-6666-4666-8666-666666666666";

beforeAll(async () => {
  await applyMigrations(env.DB);
  await seedUser(env.DB, U1);
  await seedUser(env.DB, U2);
});

describe("/api/expenses", () => {
  it("creates an expense", async () => {
    const res = await api(U1, "PUT", `/api/expenses/${E1}`, {
      amountCents: 2350,
      category: "parking",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["amountCents"]).toBe(2350);
    expect(body["gigId"]).toBeNull();
  });

  it("links an expense to an owned gig", async () => {
    await api(U1, "PUT", `/api/gigs/${GIG}`, {});
    const res = await api(U1, "PUT", `/api/expenses/${E1}`, {
      amountCents: 900,
      gigId: GIG,
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { gigId: string }).gigId).toBe(GIG);
  });

  it("400s when linking another user's gig", async () => {
    await api(U2, "PUT", `/api/gigs/${GIG}`, {});
    const res = await api(U1, "PUT", `/api/expenses/${E1}`, {
      amountCents: 900,
      gigId: GIG,
    });
    expect(res.status).toBe(400);
  });

  it("400s without amountCents", async () => {
    const res = await api(U1, "PUT", `/api/expenses/${E1}`, {
      category: "gas",
    });
    expect(res.status).toBe(400);
  });

  it("400s on zero or negative amounts", async () => {
    expect(
      (await api(U1, "PUT", `/api/expenses/${E1}`, { amountCents: 0 })).status,
    ).toBe(400);
    expect(
      (await api(U1, "PUT", `/api/expenses/${E1}`, { amountCents: -500 })).status,
    ).toBe(400);
  });

  it("delete is user-scoped", async () => {
    await api(U1, "PUT", `/api/expenses/${E1}`, { amountCents: 100 });
    expect((await api(U2, "DELETE", `/api/expenses/${E1}`)).status).toBe(404);
    expect((await api(U1, "DELETE", `/api/expenses/${E1}`)).status).toBe(204);
  });
});

// Phase 9: "the client should cover this". An expectation, not a
// receipt — reports still subtract it from net.
describe("reimbursable expenses", () => {
  const REI = "92222222-2222-4222-8222-222222222222";

  it("defaults to false and round-trips when set", async () => {
    await api(U1, "PUT", `/api/expenses/${REI}`, { amountCents: 1200 });
    const bare = (await (await api(U1, "GET", `/api/expenses/${REI}`)).json()) as {
      reimbursable: boolean;
    };
    expect(bare.reimbursable).toBe(false);

    await api(U1, "PUT", `/api/expenses/${REI}`, {
      amountCents: 1200,
      reimbursable: true,
    });
    const flagged = (await (await api(U1, "GET", `/api/expenses/${REI}`)).json()) as {
      reimbursable: boolean;
    };
    expect(flagged.reimbursable).toBe(true);
  });
});
