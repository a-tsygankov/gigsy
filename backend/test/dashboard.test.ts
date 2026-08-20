/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations, seedUser } from "./helpers/db.ts";
import { api } from "./helpers/api.ts";

const U1 = "user-1";
const U2 = "user-2";
// Hourly gigs live under their own user so the fixed-pay totals above
// stay the exact numbers they were written as.
const U3 = "user-3";
// Cancelled gigs and the retired 'paid' status get their own user too,
// so their totals don't have to be reconciled against U1's fixture.
const U4 = "user-4";
const ACME = "11111111-aaaa-4aaa-8aaa-111111111111";
const FUTURE_NEAR = "21111111-1111-4111-8111-111111111111"; // +10d confirmed
const FUTURE_FAR = "22222222-2222-4222-8222-222222222222"; // +60d lead
const COMPLETED = "23333333-3333-4333-8333-333333333333"; // -5d completed
// -10d, fully paid. Migration 0015 collapses the old status "paid"
// into "completed"; this fixture is what that status used to look
// like, seeded as "completed" directly since "paid" is no longer
// accepted.
const PAID_IN_FULL = "24444444-4444-4444-8444-444444444444";
const SVC_FUTURE = "31111111-1111-4111-8111-111111111111";
const SVC_UNPAID = "32222222-2222-4222-8222-222222222222";
// C2 (code review, 2026-08-19): gigs.amountPaidCents is derived from
// payment allocations now (Phase 4) and can no longer be set directly
// on the gig — these seed it the same way a real client would, through
// a payment naming its gig (the legacy compat path, routes/payments.ts),
// which produces exactly one allocation for the full amount.
const PAY_COMPLETED = "41111111-1111-4111-8111-111111111111";
const PAY_PAID_IN_FULL = "42222222-2222-4222-8222-222222222222";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

interface Dashboard {
  completedCount: number;
  expectedCents: number;
  unpaidCents: number;
  unpaidJobs: {
    gigId: string;
    clientName: string | null;
    offeredCents: number;
    paidCents: number;
    servicesOfferedCents: number;
    servicesPaidCents: number;
    outstandingCents: number;
  }[];
}

async function dashboard(userId: string, query = ""): Promise<Dashboard> {
  const res = await api(userId, "GET", `/api/reports/dashboard${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as Dashboard;
}

beforeAll(async () => {
  await applyMigrations(env.DB);
  await seedUser(env.DB, U1);
  await seedUser(env.DB, U2);
  await seedUser(env.DB, U3);
  await seedUser(env.DB, U4);
  await api(U1, "PUT", `/api/clients/${ACME}`, { name: "Acme" });

  // Future: confirmed +10d offered 20000 (+ service 5000), lead +60d 10000.
  await api(U1, "PUT", `/api/gigs/${FUTURE_NEAR}`, {
    clientId: ACME,
    status: "confirmed",
    dateTime: NOW + 10 * DAY,
    amountOfferedCents: 20000,
  });
  await api(U1, "PUT", `/api/services/${SVC_FUTURE}`, {
    gigId: FUTURE_NEAR,
    description: "Extra hour",
    amountOfferedCents: 5000,
  });
  await api(U1, "PUT", `/api/gigs/${FUTURE_FAR}`, {
    status: "lead",
    dateTime: NOW + 60 * DAY,
    amountOfferedCents: 10000,
  });

  // Done work: completed -5d offered 15000 paid 5000 with a service
  // 4000/1000; fully paid gig -10d 8000/8000.
  await api(U1, "PUT", `/api/gigs/${COMPLETED}`, {
    clientId: ACME,
    status: "completed",
    dateTime: NOW - 5 * DAY,
    amountOfferedCents: 15000,
  });
  await api(U1, "PUT", `/api/payments/${PAY_COMPLETED}`, {
    amountCents: 5000,
    gigId: COMPLETED,
  });
  await api(U1, "PUT", `/api/services/${SVC_UNPAID}`, {
    gigId: COMPLETED,
    description: "Overtime",
    amountOfferedCents: 4000,
    amountPaidCents: 1000,
    isCompleted: true,
  });
  await api(U1, "PUT", `/api/gigs/${PAID_IN_FULL}`, {
    clientId: ACME,
    status: "completed",
    dateTime: NOW - 10 * DAY,
    amountOfferedCents: 8000,
  });
  await api(U1, "PUT", `/api/payments/${PAY_PAID_IN_FULL}`, {
    amountCents: 8000,
    gigId: PAID_IN_FULL,
  });
});

describe("GET /api/reports/dashboard", () => {
  it("counts every completed gig, including what used to be marked paid", async () => {
    const d = await dashboard(U1);
    expect(d.completedCount).toBe(2);
  });

  it("expected money = offered on future lead/confirmed gigs + their services", async () => {
    const d = await dashboard(U1);
    expect(d.expectedCents).toBe(35000); // 20000 + 5000 + 10000
  });

  it("future window narrows expected money", async () => {
    const d = await dashboard(
      U1,
      `?futureFrom=${NOW}&futureTo=${NOW + 30 * DAY}`,
    );
    expect(d.expectedCents).toBe(25000); // far lead gig excluded
  });

  it("unpaid = outstanding on completed gigs incl. services, with drill-down rows", async () => {
    const d = await dashboard(U1);
    expect(d.unpaidCents).toBe(13000); // (15000-5000) + (4000-1000)
    expect(d.unpaidJobs).toHaveLength(1);
    expect(d.unpaidJobs[0]).toMatchObject({
      gigId: COMPLETED,
      clientName: "Acme",
      offeredCents: 15000,
      paidCents: 5000,
      servicesOfferedCents: 4000,
      servicesPaidCents: 1000,
      outstandingCents: 13000,
    });
  });

  it("is user-isolated", async () => {
    const d = await dashboard(U2);
    expect(d.completedCount).toBe(0);
    expect(d.expectedCents).toBe(0);
    expect(d.unpaidCents).toBe(0);
    expect(d.unpaidJobs).toEqual([]);
  });
});

// The regression this column exists for: an hourly gig carries no
// amount_offered_cents at all (GigEdit saves it as null so the figure
// stays computed), so every dashboard total read it as zero.
describe("GET /api/reports/dashboard — hourly gigs", () => {
  const HOURLY_FUTURE = "25555555-5555-4555-8555-555555555555";
  const HOURLY_DONE = "26666666-6666-4666-8666-666666666666";

  it("counts an hourly gig's computed pay as expected money", async () => {
    await api(U3, "PUT", `/api/gigs/${HOURLY_FUTURE}`, {
      status: "confirmed",
      dateTime: NOW + 3 * DAY,
      payType: "hourly",
      hourlyRateCents: 5000,
      durationMinutes: 480,
    });
    const d = await dashboard(U3);
    expect(d.expectedCents).toBe(40000); // $50/h × 8h
  });

  it("counts an hourly gig's computed pay as outstanding when unpaid", async () => {
    const start = Date.UTC(2026, 8, 12, 9);
    await api(U3, "PUT", `/api/gigs/${HOURLY_DONE}`, {
      status: "completed",
      dateTime: NOW - 3 * DAY,
      payType: "hourly",
      hourlyRateCents: 5000,
      durationMinutes: 480,
      // Six hours actually worked, less a 30 minute break: the actuals
      // win over the plan, so this is 5.5h not 8h.
      workStartedAt: start,
      workEndedAt: start + 6 * 60 * 60 * 1000,
      breakMinutes: 30,
    });
    const d = await dashboard(U3);
    expect(d.unpaidCents).toBe(27500);
    expect(d.unpaidJobs[0]).toMatchObject({
      gigId: HOURLY_DONE,
      offeredCents: 27500,
      paidCents: 0,
      outstandingCents: 27500,
    });
  });
});

// Migration 0015: 'paid' stops being a settable status, and 'cancelled'
// becomes one. U4 keeps these fixtures isolated from U1's shared totals
// above.
describe("GET /api/reports/dashboard — cancelled gigs, and 'paid' retired", () => {
  const SOLO_COMPLETED = "27777777-7777-4777-8777-777777777777";
  const REJECTED_PAID = "28888888-8888-4888-8888-888888888888";
  const CANCELLED = "29999999-9999-4999-8999-999999999999";

  it("counts completed gigs only — 'paid' is no longer a status", async () => {
    await api(U4, "PUT", `/api/gigs/${SOLO_COMPLETED}`, {
      status: "completed",
      amountOfferedCents: 15000,
    });

    const d = await dashboard(U4);
    expect(d.completedCount).toBe(1);
  });

  it("rejects an attempt to set status to 'paid'", async () => {
    const res = await api(U4, "PUT", `/api/gigs/${REJECTED_PAID}`, {
      status: "paid",
      amountOfferedCents: 1000,
    });
    expect(res.status).toBe(400);
  });

  it("ignores cancelled gigs entirely", async () => {
    // Each `it` here rolls back to the beforeAll snapshot (db.ts), so
    // this is U4's only gig — a plain 0 proves cancelling contributes
    // neither to the completed count nor to expected money, rather
    // than merely failing to change a total seeded by another test.
    await api(U4, "PUT", `/api/gigs/${CANCELLED}`, {
      status: "cancelled",
      amountOfferedCents: 15000,
    });

    const d = await dashboard(U4);
    expect(d.completedCount).toBe(0);
    expect(d.expectedCents).toBe(0);
  });
});
