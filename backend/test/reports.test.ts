/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeAll } from "vitest";
import { SELF, env } from "cloudflare:test";
import { applyMigrations, seedUser } from "./helpers/db.ts";
import { api } from "./helpers/api.ts";

const U1 = "user-1";
const U2 = "user-2";
const ACME = "11111111-aaaa-4aaa-8aaa-111111111111";
const BRAVO = "22222222-bbbb-4bbb-8bbb-222222222222";
const G1 = "31111111-1111-4111-8111-111111111111";
const G2 = "32222222-2222-4222-8222-222222222222";
const G3 = "33333333-3333-4333-8333-333333333333";
const G4 = "34444444-4444-4444-8444-444444444444";
const E1 = "41111111-1111-4111-8111-111111111111";
const E2 = "42222222-2222-4222-8222-222222222222";
const S1 = "51111111-1111-4111-8111-111111111111";

const SEP = Date.UTC(2026, 8, 10, 12); // 2026-09
const OCT = Date.UTC(2026, 9, 5, 12); // 2026-10

interface Summary {
  totals: {
    offeredCents: number;
    paidCents: number;
    varianceCents: number;
    expensesCents: number;
    netCents: number;
  };
  byMonth: {
    month: string;
    offeredCents: number;
    paidCents: number;
    expensesCents: number;
    netCents: number;
  }[];
  byClient: {
    clientId: string | null;
    clientName: string | null;
    offeredCents: number;
    paidCents: number;
  }[];
}

async function summary(userId: string, query = ""): Promise<Summary> {
  const res = await api(userId, "GET", `/api/reports/summary${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as Summary;
}

beforeAll(async () => {
  await applyMigrations(env.DB);
  await seedUser(env.DB, U1);
  await seedUser(env.DB, U2);

  await api(U1, "PUT", `/api/clients/${ACME}`, { name: "Acme" });
  await api(U1, "PUT", `/api/clients/${BRAVO}`, { name: "Bravo" });

  // Sep: Acme gig, offered 10000 / paid 8000, with a 2000 expense.
  await api(U1, "PUT", `/api/gigs/${G1}`, {
    clientId: ACME,
    status: "paid",
    dateTime: SEP,
    amountOfferedCents: 10000,
    amountPaidCents: 8000,
  });
  await api(U1, "PUT", `/api/expenses/${E1}`, { gigId: G1, amountCents: 2000 });
  // …plus an additional service on that gig: 3000 offered / 1000 paid.
  // Service money is income and follows its gig's month and client.
  await api(U1, "PUT", `/api/services/${S1}`, {
    gigId: G1,
    description: "Overtime hour",
    amountOfferedCents: 3000,
    amountPaidCents: 1000,
  });

  // Oct: Acme 20000/20000, Bravo 5000/unpaid (+1000 expense), no-client 1000/1000.
  await api(U1, "PUT", `/api/gigs/${G2}`, {
    clientId: ACME,
    status: "paid",
    dateTime: OCT,
    amountOfferedCents: 20000,
    amountPaidCents: 20000,
  });
  await api(U1, "PUT", `/api/gigs/${G3}`, {
    clientId: BRAVO,
    status: "completed",
    dateTime: OCT,
    amountOfferedCents: 5000,
  });
  await api(U1, "PUT", `/api/expenses/${E2}`, { gigId: G3, amountCents: 1000 });
  await api(U1, "PUT", `/api/gigs/${G4}`, {
    status: "paid",
    dateTime: OCT,
    amountOfferedCents: 1000,
    amountPaidCents: 1000,
  });
});

describe("GET /api/reports/summary", () => {
  it("401s without a token", async () => {
    const res = await SELF.fetch("https://localhost/api/reports/summary");
    expect(res.status).toBe(401);
  });

  it("computes totals: offered, paid, variance, expenses, net", async () => {
    const s = await summary(U1);
    // Gig money (36000/29000) plus the service on G1 (3000/1000).
    expect(s.totals).toEqual({
      offeredCents: 39000,
      paidCents: 30000,
      varianceCents: 9000,
      expensesCents: 3000,
      netCents: 27000,
    });
  });

  it("groups by month (expenses and services follow their gig's month), ascending", async () => {
    const s = await summary(U1);
    expect(s.byMonth).toEqual([
      {
        month: "2026-09",
        offeredCents: 13000,
        paidCents: 9000,
        expensesCents: 2000,
        netCents: 7000,
      },
      {
        month: "2026-10",
        offeredCents: 26000,
        paidCents: 21000,
        expensesCents: 1000,
        netCents: 20000,
      },
    ]);
  });

  it("groups by client, unassigned gigs bucketed under null", async () => {
    const s = await summary(U1);
    const acme = s.byClient.find((c) => c.clientId === ACME);
    const bravo = s.byClient.find((c) => c.clientId === BRAVO);
    const none = s.byClient.find((c) => c.clientId === null);
    expect(acme).toEqual({
      clientId: ACME,
      clientName: "Acme",
      offeredCents: 33000, // 30000 gigs + 3000 service
      paidCents: 29000, // 28000 gigs + 1000 service
    });
    expect(bravo).toEqual({
      clientId: BRAVO,
      clientName: "Bravo",
      offeredCents: 5000,
      paidCents: 0,
    });
    expect(none).toEqual({
      clientId: null,
      clientName: null,
      offeredCents: 1000,
      paidCents: 1000,
    });
  });

  it("applies from/to filters", async () => {
    const s = await summary(U1, `?from=${Date.UTC(2026, 9, 1)}`);
    expect(s.totals.offeredCents).toBe(26000);
    expect(s.totals.expensesCents).toBe(1000);
    expect(s.byMonth.map((m) => m.month)).toEqual(["2026-10"]);
  });

  it("applies the clientId filter (expenses and services via that client's gigs)", async () => {
    const s = await summary(U1, `?clientId=${ACME}`);
    expect(s.totals).toEqual({
      offeredCents: 33000,
      paidCents: 29000,
      varianceCents: 4000,
      expensesCents: 2000,
      netCents: 27000,
    });
  });

  it("excludes a service whose gig falls outside the date filter", async () => {
    // The only service sits on the September gig.
    const s = await summary(U1, `?from=${Date.UTC(2026, 9, 1)}`);
    expect(s.totals.offeredCents).toBe(26000);
    expect(s.totals.paidCents).toBe(21000);
  });

  it("is user-isolated", async () => {
    const s = await summary(U2);
    expect(s.totals.offeredCents).toBe(0);
    expect(s.byMonth).toEqual([]);
    expect(s.byClient).toEqual([]);
  });

  it("400s on a malformed from param", async () => {
    const res = await api(U1, "GET", "/api/reports/summary?from=yesterday");
    expect(res.status).toBe(400);
  });
});
