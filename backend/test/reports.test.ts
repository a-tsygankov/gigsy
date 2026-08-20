/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeAll } from "vitest";
import { SELF, env } from "cloudflare:test";
import { applyMigrations, seedUser } from "./helpers/db.ts";
import { api } from "./helpers/api.ts";
import { AllocationsRepo } from "../src/repos/allocations.ts";
import { recomputePaidTotals } from "../src/services/paid-totals.ts";

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
    owedCents: number;
    expensesCents: number;
    reimbursableCents: number;
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
  // Seeded "completed" rather than the old "paid" — migration 0015
  // retires that status, and this 2000 shortfall now legitimately
  // reads as owed (see the owedCents assertions below) rather than
  // being hidden by a hand-set status that declared the matter closed.
  await api(U1, "PUT", `/api/gigs/${G1}`, {
    clientId: ACME,
    status: "completed",
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
    status: "completed",
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
    status: "completed",
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

  it("computes totals: offered, paid, owed, expenses, net", async () => {
    const s = await summary(U1);
    // Gig money (36000/29000) plus the service on G1 (3000/1000).
    expect(s.totals).toEqual({
      offeredCents: 39000,
      paidCents: 30000,
      // Every completed gig, clamped per gig, gig plus its own
      // services: G1 (gig 10000−8000=2000, service S1 3000−1000=2000
      // → 4000) and G3 (5000−0=5000, no services); G2 and G4 are paid
      // in full and contribute nothing. G1's 4000 no longer has a
      // hand-set `paid` status left to hide it — that is what retiring
      // the status was for.
      owedCents: 9000,
      expensesCents: 3000,
      reimbursableCents: 0,
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
      // G1: completed and genuinely short, gig and service both — 2000
      // (10000 offered, 8000 paid) plus S1's 2000 (3000 offered, 1000
      // paid) — with no `paid` status left to mark it settled by hand.
      // G2 is paid in full and contributes nothing.
      owedCents: 4000,
      expensesCents: 2000,
      reimbursableCents: 0,
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

  it("excludes a cancelled gig and its service from money, but keeps its expenses", async () => {
    // Migration 0015: a cancelled gig fell through and stops counting
    // as money — offered, paid, owed, and its own service go with it,
    // the same way it stops occupying time and stops holding a
    // calendar event. Its expenses are the deliberate exception
    // (reports.ts header comment): travel booked or materials bought
    // before the gig cancelled were still spent, so they still reduce
    // net. Diffed against a before/after baseline so this doesn't have
    // to reason about every other fixture in beforeAll.
    const before = await summary(U1);
    const beforeOct = before.byMonth.find((m) => m.month === "2026-10");

    const CANCELLED = "35555555-5555-4555-8555-555555555555";
    const CANCELLED_SVC = "36666666-6666-4666-8666-666666666666";
    const CANCELLED_EXP = "37777777-7777-4777-8777-777777777777";

    await api(U1, "PUT", `/api/gigs/${CANCELLED}`, {
      status: "cancelled",
      dateTime: OCT,
      amountOfferedCents: 999_999,
      amountPaidCents: 999_999,
    });
    await api(U1, "PUT", `/api/services/${CANCELLED_SVC}`, {
      gigId: CANCELLED,
      description: "Would-have-been overtime",
      amountOfferedCents: 500_000,
      amountPaidCents: 500_000,
    });
    await api(U1, "PUT", `/api/expenses/${CANCELLED_EXP}`, {
      gigId: CANCELLED,
      amountCents: 3000,
    });

    const after = await summary(U1);
    const afterOct = after.byMonth.find((m) => m.month === "2026-10");

    // The gig and its service: invisible to money totals.
    expect(after.totals.offeredCents).toBe(before.totals.offeredCents);
    expect(after.totals.paidCents).toBe(before.totals.paidCents);
    expect(after.totals.owedCents).toBe(before.totals.owedCents);
    expect(after.byClient).toEqual(before.byClient);
    expect(afterOct?.offeredCents).toBe(beforeOct?.offeredCents ?? 0);
    expect(afterOct?.paidCents).toBe(beforeOct?.paidCents ?? 0);

    // The expense: still counted, both in the total and in October.
    expect(after.totals.expensesCents).toBe(before.totals.expensesCents + 3000);
    expect(after.totals.netCents).toBe(before.totals.netCents - 3000);
    expect(afterOct?.expensesCents).toBe((beforeOct?.expensesCents ?? 0) + 3000);
    expect(afterOct?.netCents).toBe((beforeOct?.netCents ?? 0) - 3000);
  });
});

// Phase 9: an expense the client should cover is still subtracted from
// net — the flag records an expectation, not money received — but the
// recoverable amount is reported alongside it.
describe("reimbursable expenses in the summary", () => {
  const E3 = "43333333-3333-4333-8333-333333333333";

  it("reports the recoverable total without changing net", async () => {
    const before = await summary(U1);

    await api(U1, "PUT", `/api/expenses/${E3}`, {
      gigId: G1,
      amountCents: 1500,
      reimbursable: true,
    });

    const after = await summary(U1);
    expect(after.totals.reimbursableCents).toBe(1500);
    expect(after.totals.expensesCents).toBe(before.totals.expensesCents + 1500);
    // Net drops by the full amount: the money has not arrived.
    expect(after.totals.netCents).toBe(before.totals.netCents - 1500);
  });
});

/**
 * "Still owed" — the tile people read to decide who to chase.
 *
 * It used to be Σoffered − Σpaid over every gig in the period, which
 * got two things wrong at once. These tests pin both, because both are
 * the kind of mistake that reappears the moment someone "simplifies"
 * the query back into a sum over the monthly rows.
 */
describe("owedCents", () => {
  // 6-prefixed: 5… is already taken by S1 at the top of the file.
  const GL = "61111111-1111-4111-8111-111111111111";
  const GC = "62222222-2222-4222-8222-222222222222";
  const GD = "63333333-3333-4333-8333-333333333333";
  const SD = "64444444-4444-4444-8444-444444444444";

  it("ignores leads and confirmed gigs — those are expected, not owed", async () => {
    const before = await summary(U1);

    await api(U1, "PUT", `/api/gigs/${GL}`, {
      status: "lead",
      dateTime: OCT,
      amountOfferedCents: 500_000,
    });
    await api(U1, "PUT", `/api/gigs/${GC}`, {
      status: "confirmed",
      dateTime: OCT,
      amountOfferedCents: 500_000,
    });

    const after = await summary(U1);
    // A million cents of speculative work must not read as debt…
    expect(after.totals.owedCents).toBe(before.totals.owedCents);
    // …but it is still money offered, which is a different question and
    // one the report is right to answer. Asserting the exact increase,
    // because "greater than zero" would pass even if the gigs had been
    // dropped from the report altogether.
    expect(after.totals.offeredCents).toBe(before.totals.offeredCents + 1_000_000);
  });

  it("clamps per gig, so an overpayment cannot cancel someone else's debt", async () => {
    const before = (await summary(U1)).totals.owedCents;

    // Completed and generously overpaid — a tip, a rounded-up invoice.
    await api(U1, "PUT", `/api/gigs/${GD}`, {
      status: "completed",
      dateTime: OCT,
      amountOfferedCents: 1000,
      amountPaidCents: 9000,
    });

    // Unclamped this would subtract 8000 from what other clients owe,
    // and a big enough tip would show zero outstanding while invoices
    // went unpaid.
    expect((await summary(U1)).totals.owedCents).toBe(before);
  });

  it("counts unpaid services on a completed gig", async () => {
    const before = (await summary(U1)).totals.owedCents;

    await api(U1, "PUT", `/api/services/${SD}`, {
      gigId: G3, // the completed Bravo gig
      description: "Extra hour",
      amountOfferedCents: 2500,
      amountPaidCents: 500,
    });

    expect((await summary(U1)).totals.owedCents).toBe(before + 2000);
  });

  it("respects the report's own filters", async () => {
    // Bravo's only gig, G3, is completed and entirely unpaid.
    const bravo = await summary(U1, `?clientId=${BRAVO}`);
    expect(bravo.totals.owedCents).toBeGreaterThan(0);

    // G1 is the only gig in September: completed, with a 2000
    // shortfall of its own plus S1's 2000 — no `paid` status left to
    // mark either settled by hand.
    const september = await summary(
      U1,
      `?from=${Date.UTC(2026, 8, 1)}&to=${Date.UTC(2026, 8, 30)}`,
    );
    expect(september.totals.owedCents).toBe(4000);
  });
});

/**
 * Hourly gigs — money that was missing from this report entirely.
 *
 * An hourly gig is saved with amount_offered_cents null on purpose, so
 * the figure stays computed from rate × time (domain/gig-pay.ts). Every
 * total here summed that null column, so a $50/h eight-hour shift was
 * reported as $0.00 offered and $0.00 owed. The report reads
 * gigs.expected_cents now; these deltas are what say so.
 */
describe("hourly gigs in the summary", () => {
  // 7-prefixed: 6… is taken by the owedCents block above.
  const GH = "71111111-1111-4111-8111-111111111111";

  it("reports an hourly gig's computed pay as offered, owed, by month and by client", async () => {
    const before = await summary(U1);
    const beforeOct = before.byMonth.find((m) => m.month === "2026-10");
    const beforeBravo = before.byClient.find((c) => c.clientId === BRAVO);

    await api(U1, "PUT", `/api/gigs/${GH}`, {
      clientId: BRAVO,
      status: "completed",
      dateTime: OCT,
      payType: "hourly",
      hourlyRateCents: 5000,
      durationMinutes: 480,
    });

    const after = await summary(U1);
    // $50/h × 8h, and not a cent of it in amount_offered_cents.
    expect(after.totals.offeredCents).toBe(before.totals.offeredCents + 40000);
    // Completed and unpaid, so it is owed as well as offered.
    expect(after.totals.owedCents).toBe(before.totals.owedCents + 40000);
    expect(after.byMonth.find((m) => m.month === "2026-10")?.offeredCents).toBe(
      (beforeOct?.offeredCents ?? 0) + 40000,
    );
    expect(after.byClient.find((c) => c.clientId === BRAVO)?.offeredCents).toBe(
      (beforeBravo?.offeredCents ?? 0) + 40000,
    );
    // Nothing was received, so paid money is untouched — expected_cents
    // replaced the offered column and only that one.
    expect(after.totals.paidCents).toBe(before.totals.paidCents);
  });

  it("uses the work actually logged once the shift is over", async () => {
    const before = (await summary(U1)).totals.offeredCents;
    const start = Date.UTC(2026, 9, 5, 9);

    await api(U1, "PUT", `/api/gigs/${GH}`, {
      clientId: BRAVO,
      status: "completed",
      dateTime: OCT,
      payType: "hourly",
      hourlyRateCents: 5000,
      durationMinutes: 480,
      workStartedAt: start,
      workEndedAt: start + 6 * 60 * 60 * 1000,
      breakMinutes: 30,
    });

    // 5.5h at $50/h — the actuals beat the eight-hour plan.
    expect((await summary(U1)).totals.offeredCents).toBe(before + 27500);
  });
});

/**
 * Phase 4 (payment allocations, migration 0016): money received vs.
 * money attributed to a gig are two different questions, and
 * totals.paidCents answers the first — see reports.ts's header. These
 * pin the case that made the old model wrong: a payment banked before
 * (or without ever) being fully allocated must still show up as money
 * received, not vanish until someone finishes the bookkeeping.
 *
 * The allocation ROUTES and the sync entity that create allocations are
 * still in review as of this test — only AllocationsRepo and
 * recomputePaidTotals (this phase's Task 2) are merged on this branch.
 * So the split here is seeded by calling them directly, the same way
 * dashboard.test.ts's equivalent block does; an equivalent route-level
 * test belongs in allocations-routes.test.ts once PUT /api/allocations
 * exists.
 */
describe("money received vs. money allocated", () => {
  const U6 = "user-6";
  const CHARLIE = "81111111-1111-4111-8111-111111111111";
  const GIG_R = "82222222-2222-4222-8222-222222222222";
  const PAY_R = "83333333-3333-4333-8333-333333333333";

  // Each `it` in this file rolls back to the shared beforeAll snapshot
  // afterward (vitest-pool-workers isolated storage — see
  // dashboard.test.ts), so a test that seeds U6 cannot assume another
  // test's U6 writes are still there. Both tests below that need this
  // fixture call this helper themselves rather than sharing state.
  async function seedU6SplitPayment(): Promise<void> {
    await seedUser(env.DB, U6);
    await api(U6, "PUT", `/api/clients/${CHARLIE}`, { name: "Charlie" });
    await api(U6, "PUT", `/api/gigs/${GIG_R}`, {
      clientId: CHARLIE,
      status: "completed",
      dateTime: OCT,
      amountOfferedCents: 20000,
    });
    // A $150 payment, paid in October, of which only $60 has been
    // allocated to the gig so far — the other $90 is banked but not
    // yet assigned to any work.
    await api(U6, "PUT", `/api/payments/${PAY_R}`, {
      amountCents: 15000,
      paidAt: OCT,
    });
    // PaymentInput doesn't accept clientId yet — that's this phase's
    // Task 3, still in review — so the route can't do this. Setting it
    // directly is how this test exercises reports.ts's clientId filter
    // on the unallocated remainder ahead of that route landing; once it
    // does, this can go through `PUT /api/payments` like everything
    // else here.
    await env.DB.prepare("UPDATE payments SET client_id = ? WHERE id = ?")
      .bind(CHARLIE, PAY_R)
      .run();
    await AllocationsRepo.for(env.DB).upsert(
      U6,
      crypto.randomUUID(),
      { paymentId: PAY_R, gigId: GIG_R, amountCents: 6000 },
      { now: 1 },
    );
    await recomputePaidTotals(env.DB, U6, [GIG_R], 1);
  }

  it("counts the unallocated remainder of a payment as received but unassigned", async () => {
    await seedU6SplitPayment();

    const s = await summary(U6);

    // The gig itself only shows what was actually allocated to it —
    // this is the "how much has this gig been paid" question, and
    // must not be inflated by money that hasn't been assigned to it.
    expect(s.byMonth).toEqual([
      { month: "2026-10", offeredCents: 20000, paidCents: 6000, expensesCents: 0, netCents: 6000 },
    ]);
    expect(s.byClient).toEqual([
      { clientId: CHARLIE, clientName: "Charlie", offeredCents: 20000, paidCents: 6000 },
    ]);

    // But the top-level total is "how much money did I receive" — the
    // full $150, not just the $60 that has found a gig so far. If the
    // unallocated $90 were silently dropped, this would read 6000
    // instead; if it were double-counted on top of the per-gig figure
    // that already includes the allocated $60, this would read 21000.
    expect(s.totals.paidCents).toBe(15000);
    expect(s.totals.netCents).toBe(15000);
  });

  it("does not double-count once the payment is fully allocated", async () => {
    const U7 = "user-7";
    const GIG_F = "84444444-4444-4444-8444-444444444444";
    const PAY_F = "85555555-5555-4555-8555-555555555555";
    await seedUser(env.DB, U7);
    await api(U7, "PUT", `/api/gigs/${GIG_F}`, {
      status: "completed",
      dateTime: OCT,
      amountOfferedCents: 10000,
    });
    await api(U7, "PUT", `/api/payments/${PAY_F}`, {
      amountCents: 10000,
      paidAt: OCT,
    });
    await AllocationsRepo.for(env.DB).upsert(
      U7,
      crypto.randomUUID(),
      { paymentId: PAY_F, gigId: GIG_F, amountCents: 10000 },
      { now: 1 },
    );
    await recomputePaidTotals(env.DB, U7, [GIG_F], 1);

    const s = await summary(U7);
    // Fully allocated: the per-gig figure and the received figure agree
    // exactly, with nothing left over to add.
    expect(s.totals.paidCents).toBe(10000);
    expect(s.byMonth[0]?.paidCents).toBe(10000);
  });

  it("respects the date and clientId filters on the unallocated remainder", async () => {
    // Same fixture as the first test — re-seeded here because per-test
    // rollback means that test's writes aren't visible to this one.
    // $150 paid in October, $90 of it unallocated, against Charlie's gig.
    await seedU6SplitPayment();

    const outsideWindow = await summary(
      U6,
      `?from=${Date.UTC(2026, 8, 1)}&to=${Date.UTC(2026, 8, 30)}`,
    );
    expect(outsideWindow.totals.paidCents).toBe(0);

    const wrongClient = await summary(U6, `?clientId=${GIG_R}`);
    // GIG_R is not a real client id, so this filters to nothing — the
    // unallocated remainder must not leak into a client it wasn't
    // recorded against.
    expect(wrongClient.totals.paidCents).toBe(0);

    const rightClient = await summary(U6, `?clientId=${CHARLIE}`);
    expect(rightClient.totals.paidCents).toBe(15000);
  });
});
