/// <reference types="@cloudflare/vitest-pool-workers" />
/**
 * The rule this file pins: a delivered gig is treated exactly as a
 * completed one everywhere money or time is counted.
 *
 * Adding a value to an enum silently SUBTRACTS from every query saying
 * `status = 'completed'`. Five such places live in the backend, and
 * each fails quietly — a total that is simply smaller, with nothing to
 * indicate a row was skipped.
 *
 * Every assertion compares two users whose fixtures are identical
 * except for the status. That states the rule itself rather than
 * pinning an arithmetic result a fixture change would invalidate: widen
 * four of the five sites and the two users disagree.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations, seedUser } from "./helpers/db.ts";
import { api } from "./helpers/api.ts";
import { selectNudge } from "../src/push/nudges.ts";
import { BUSY_STATUSES } from "../src/services/availability.ts";

// Two users, identical fixtures, one status apart.
const U_DONE = "delivered-cmp-completed";
const U_SENT = "delivered-cmp-delivered";

// C3: entity ids are a single global primary key (ClientsRepo.upsert /
// GigsRepo.upsert reject a write when the row already belongs to a
// different user), so U_DONE and U_SENT each need their own set of
// ids — sharing one UUID across the two users made the second user's
// writes fail as "forbidden" (a 400 cascading from a 404 on the
// client). Keyed by user so the pairing stays obvious at the call site.
const ACME: Record<string, string> = {
  [U_DONE]: "aa000000-0000-4000-8000-00000000000d",
  [U_SENT]: "aa000000-0000-4000-8000-00000000000e",
};
const GIG: Record<string, string> = {
  [U_DONE]: "ab000000-0000-4000-8000-00000000000d",
  [U_SENT]: "ab000000-0000-4000-8000-00000000000e",
};
const PAY: Record<string, string> = {
  [U_DONE]: "ac000000-0000-4000-8000-00000000000d",
  [U_SENT]: "ac000000-0000-4000-8000-00000000000e",
};

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

interface Dashboard {
  completedCount: number;
  unpaidCents: number;
  unpaidJobs: { gigId: string; outstandingCents: number }[];
}

async function dashboard(userId: string): Promise<Dashboard> {
  const res = await api(userId, "GET", "/api/reports/dashboard");
  expect(res.status).toBe(200);
  return (await res.json()) as Dashboard;
}

interface Summary {
  totals: { owedCents: number };
}

// C3: the real route nests the figure under `totals` (see
// test/reports.test.ts's Summary interface) — there is no top-level
// `owedCents` on the response.
async function owedCents(userId: string): Promise<number> {
  const res = await api(userId, "GET", "/api/reports/summary");
  expect(res.status).toBe(200);
  const body = (await res.json()) as Summary;
  return body.totals.owedCents;
}

// C3: `PUT /api/gigs/:id` always stamps modified_at with the request's
// own Date.now() (routes/gigs.ts), so there is no way through the API
// to make a just-created gig look old. The nudge's unpaid check reads
// modified_at directly, so the age has to be written the same way
// test/push-nudges.test.ts's own `age()` helper does: with a raw
// UPDATE against the row.
async function age(gigId: string, modifiedAt: number): Promise<void> {
  await env.DB.prepare("UPDATE gigs SET modified_at = ? WHERE id = ?")
    .bind(modifiedAt, gigId)
    .run();
}

/** The same gig and the same partial payment, under either status. */
async function seedFor(userId: string, status: string): Promise<void> {
  const acme = ACME[userId]!;
  const gig = GIG[userId]!;
  const pay = PAY[userId]!;
  await seedUser(env.DB, userId);
  await api(userId, "PUT", `/api/clients/${acme}`, { name: "Acme" });
  await api(userId, "PUT", `/api/gigs/${gig}`, {
    clientId: acme,
    status,
    dateTime: NOW - 30 * DAY,
    amountOfferedCents: 15000,
  });
  // Backdate past the nudge's 14-day unpaid threshold (DEFAULT_THRESHOLDS
  // in src/push/nudges.ts) — the write above always stamps "now".
  await age(gig, NOW - 30 * DAY);
  // Partly paid, so the gig is genuinely still owed something.
  await api(userId, "PUT", `/api/payments/${pay}`, {
    amountCents: 5000,
    gigId: gig,
  });
}

beforeAll(async () => {
  await applyMigrations(env.DB);
  await seedFor(U_DONE, "completed");
  await seedFor(U_SENT, "delivered");
});

describe("a delivered gig is treated as completed", () => {
  it("stays in the dashboard's outstanding total", async () => {
    const done = await dashboard(U_DONE);
    const sent = await dashboard(U_SENT);
    expect(sent.unpaidCents).toBe(done.unpaidCents);
    expect(sent.unpaidCents).toBeGreaterThan(0);
  });

  it("stays in the dashboard's unpaid job list", async () => {
    const sent = await dashboard(U_SENT);
    expect(sent.unpaidJobs.map((j) => j.gigId)).toContain(GIG[U_SENT]);
  });

  it("is counted as completed work", async () => {
    const done = await dashboard(U_DONE);
    const sent = await dashboard(U_SENT);
    expect(sent.completedCount).toBe(done.completedCount);
    expect(sent.completedCount).toBe(1);
  });

  it("stays in the report's owed figure", async () => {
    expect(await owedCents(U_SENT)).toBe(await owedCents(U_DONE));
    expect(await owedCents(U_SENT)).toBeGreaterThan(0);
  });

  it("still raises an unpaid nudge", async () => {
    const done = await selectNudge(env.DB, U_DONE, NOW);
    const sent = await selectNudge(env.DB, U_SENT, NOW);
    expect(sent?.key).toBe(`unpaid:${GIG[U_SENT]}`);
    expect(done?.key).toBe(`unpaid:${GIG[U_DONE]}`);
  });

  it("still blocks its time on the public availability page", async () => {
    // BUSY_STATUSES is what a stranger's view of a shared page is built
    // from, so assert it directly rather than inferring it from a slot
    // calculation that could pass for the wrong reason.
    expect(BUSY_STATUSES).toContain("delivered");
    expect(BUSY_STATUSES).toContain("completed");
  });
});
