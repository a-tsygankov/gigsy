/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations, seedUser } from "./helpers/db.ts";
import { api } from "./helpers/api.ts";

const U1 = "user-1";
const U2 = "user-2";
const GIG = "11111111-aaaa-4aaa-8aaa-111111111111";
const SVC = "22222222-bbbb-4bbb-8bbb-222222222222";
const PAY = "33333333-cccc-4ccc-8ccc-333333333333";

type SyncResponse = { results: { id: string; status: string }[] };

async function sync(userId: string, ops: unknown[]): Promise<SyncResponse> {
  const res = await api(userId, "POST", "/api/sync", { ops });
  expect(res.status).toBe(200);
  return (await res.json()) as SyncResponse;
}

beforeAll(async () => {
  await applyMigrations(env.DB);
  await seedUser(env.DB, U1);
  await seedUser(env.DB, U2);
  await api(U1, "PUT", `/api/gigs/${GIG}`, { status: "confirmed" });
});

describe("POST /api/sync — service + payment entities", () => {
  it("applies payment then service (with payment link) in one batch", async () => {
    const body = await sync(U1, [
      {
        entity: "payment",
        op: "upsert",
        id: PAY,
        modifiedAt: 1000,
        payload: { gigId: GIG, amountCents: 5000 },
      },
      {
        entity: "service",
        op: "upsert",
        id: SVC,
        modifiedAt: 1000,
        payload: {
          gigId: GIG,
          description: "Banner install",
          amountOfferedCents: 5000,
          amountPaidCents: 5000,
          paymentId: PAY,
          isCompleted: true,
        },
      },
    ]);
    expect(body.results.map((r) => r.status)).toEqual(["applied", "applied"]);

    const svc = (await (await api(U1, "GET", `/api/services/${SVC}`)).json()) as {
      paymentId: string;
      isCompleted: boolean;
      modifiedAt: number;
    };
    expect(svc.paymentId).toBe(PAY);
    expect(svc.isCompleted).toBe(true);
    expect(svc.modifiedAt).toBe(1000);
  });

  it("applies LWW to service ops (stale skipped)", async () => {
    await sync(U1, [
      {
        entity: "service",
        op: "upsert",
        id: SVC,
        modifiedAt: 2000,
        payload: { gigId: GIG, description: "Newer" },
      },
    ]);
    const body = await sync(U1, [
      {
        entity: "service",
        op: "upsert",
        id: SVC,
        modifiedAt: 1000,
        payload: { gigId: GIG, description: "Older" },
      },
    ]);
    expect(body.results[0]?.status).toBe("skipped");
    const svc = (await (await api(U1, "GET", `/api/services/${SVC}`)).json()) as {
      description: string;
    };
    expect(svc.description).toBe("Newer");
  });

  it("errors on a service pointing at a gig the caller does not own", async () => {
    const body = await sync(U2, [
      {
        entity: "service",
        op: "upsert",
        id: SVC,
        modifiedAt: 1000,
        payload: { gigId: GIG, description: "Steal" },
      },
    ]);
    expect(body.results[0]?.status).toBe("error");
  });

  it("errors per-op on non-positive amounts (sync path enforces too)", async () => {
    const body = await sync(U1, [
      {
        entity: "payment",
        op: "upsert",
        id: PAY,
        modifiedAt: 5000,
        payload: { amountCents: 0 },
      },
      {
        entity: "service",
        op: "upsert",
        id: SVC,
        modifiedAt: 5000,
        payload: { gigId: GIG, description: "x", amountOfferedCents: -100 },
      },
    ]);
    expect(body.results.map((r) => r.status)).toEqual(["error", "error"]);
  });

  it("applies delete ops for both entities", async () => {
    await sync(U1, [
      {
        entity: "payment",
        op: "upsert",
        id: PAY,
        modifiedAt: 1000,
        payload: { amountCents: 1 },
      },
      {
        entity: "service",
        op: "upsert",
        id: SVC,
        modifiedAt: 1000,
        payload: { gigId: GIG, description: "x" },
      },
    ]);
    const body = await sync(U1, [
      { entity: "service", op: "delete", id: SVC, modifiedAt: 2000 },
      { entity: "payment", op: "delete", id: PAY, modifiedAt: 2000 },
    ]);
    expect(body.results.map((r) => r.status)).toEqual(["applied", "applied"]);
  });
});
