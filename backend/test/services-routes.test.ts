/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeAll } from "vitest";
import { SELF, env } from "cloudflare:test";
import { applyMigrations, seedUser } from "./helpers/db.ts";
import { api } from "./helpers/api.ts";

const U1 = "user-1";
const U2 = "user-2";
const GIG = "11111111-aaaa-4aaa-8aaa-111111111111";
const SVC = "22222222-bbbb-4bbb-8bbb-222222222222";
const PAY = "33333333-cccc-4ccc-8ccc-333333333333";

beforeAll(async () => {
  await applyMigrations(env.DB);
  await seedUser(env.DB, U1);
  await seedUser(env.DB, U2);
  await api(U1, "PUT", `/api/gigs/${GIG}`, { status: "confirmed" });
});

describe("/api/services", () => {
  it("401s without a token", async () => {
    const res = await SELF.fetch("https://localhost/api/services");
    expect(res.status).toBe(401);
  });

  it("creates a service on an owned gig with defaults", async () => {
    const res = await api(U1, "PUT", `/api/services/${SVC}`, {
      gigId: GIG,
      description: "Extra table setup",
      amountOfferedCents: 5000,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["description"]).toBe("Extra table setup");
    expect(body["isCompleted"]).toBe(false);
    expect(body["paymentId"]).toBeNull();
    expect(body["createdAt"]).toBeGreaterThan(0);
  });

  it("requires the gig link and rejects a foreign gig", async () => {
    const missing = await api(U1, "PUT", `/api/services/${SVC}`, {
      description: "No gig",
    });
    expect(missing.status).toBe(400);

    const foreign = await api(U2, "PUT", `/api/services/${SVC}`, {
      gigId: GIG,
      description: "Steal",
    });
    expect(foreign.status).toBe(400);
  });

  it("round-trips isCompleted and links an owned payment", async () => {
    await api(U1, "PUT", `/api/payments/${PAY}`, {
      gigId: GIG,
      amountCents: 5000,
    });
    const res = await api(U1, "PUT", `/api/services/${SVC}`, {
      gigId: GIG,
      description: "Extra table setup",
      amountPaidCents: 5000,
      paymentId: PAY,
      isCompleted: true,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["isCompleted"]).toBe(true);
    expect(body["paymentId"]).toBe(PAY);
  });

  it("rejects a payment link the caller does not own", async () => {
    await api(U2, "PUT", `/api/gigs/${GIG.replace("1111", "9999")}`, {});
    await api(U2, "PUT", `/api/payments/${PAY}`, { amountCents: 1 });
    const res = await api(U1, "PUT", `/api/services/${SVC}`, {
      gigId: GIG,
      description: "x",
      paymentId: PAY,
    });
    expect(res.status).toBe(400);
  });

  it("lists only own services; delete is scoped", async () => {
    await api(U1, "PUT", `/api/services/${SVC}`, {
      gigId: GIG,
      description: "Mine",
    });
    const theirs = (await (await api(U2, "GET", "/api/services")).json()) as {
      items: unknown[];
    };
    expect(theirs.items).toEqual([]);

    expect((await api(U2, "DELETE", `/api/services/${SVC}`)).status).toBe(404);
    expect((await api(U1, "DELETE", `/api/services/${SVC}`)).status).toBe(204);
  });
});

describe("/api/payments", () => {
  it("creates a payment linked to an owned gig", async () => {
    const res = await api(U1, "PUT", `/api/payments/${PAY}`, {
      gigId: GIG,
      amountCents: 12500,
      paidAt: 1700000000000,
      notes: "Zelle",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["amountCents"]).toBe(12500);
    expect(body["gigId"]).toBe(GIG);
    // Server-controlled — never set from the payload.
    expect(body["confirmationR2Key"]).toBeNull();
  });

  it("ignores a client-supplied confirmationR2Key", async () => {
    const res = await api(U1, "PUT", `/api/payments/${PAY}`, {
      amountCents: 1,
      confirmationR2Key: "u/user-2/steal",
    });
    expect(res.status).toBe(201);
    expect(
      ((await res.json()) as Record<string, unknown>)["confirmationR2Key"],
    ).toBeNull();
  });

  it("rejects a foreign gig link; scoping on get/delete", async () => {
    const foreign = await api(U2, "PUT", `/api/payments/${PAY}`, {
      gigId: GIG,
      amountCents: 1,
    });
    expect(foreign.status).toBe(400);

    await api(U1, "PUT", `/api/payments/${PAY}`, { amountCents: 1 });
    expect((await api(U2, "GET", `/api/payments/${PAY}`)).status).toBe(404);
    expect((await api(U1, "DELETE", `/api/payments/${PAY}`)).status).toBe(204);
  });
});
