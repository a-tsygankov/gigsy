/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations, seedUser } from "./helpers/db.ts";
import { api } from "./helpers/api.ts";
import { selectNudge, shouldSend, type Nudge } from "../src/push/nudges.ts";

const U1 = "nudge-user-1";
const ACME = "a1111111-1111-4111-8111-111111111111";
const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_770_000_000_000;

const GIGS = {
  unpaidOld: "b1111111-1111-4111-8111-111111111111",
  unpaidOlder: "b2222222-2222-4222-8222-222222222222",
  staleLead: "b3333333-3333-4333-8333-333333333333",
  confirmedSoon: "b4444444-4444-4444-8444-444444444444",
  paidOld: "b5555555-5555-4555-8555-555555555555",
  unpaidHourly: "b6666666-6666-4666-8666-666666666666",
};

/** modified_at is what "untouched since" means, and the API bumps it
 * on write, so it has to be set directly to simulate age. */
async function age(gigId: string, modifiedAt: number) {
  await env.DB.prepare("UPDATE gigs SET modified_at = ? WHERE id = ?")
    .bind(modifiedAt, gigId)
    .run();
}

/**
 * C2 (code review, 2026-08-19): amount_paid_cents is derived from
 * payment allocations now (Phase 4) — GigInput has no such key, so
 * `PUT /api/gigs/:id` can no longer set it. This suite is about
 * `selectNudge`'s SQL, not the write path, so it sets the column
 * directly rather than routing through a payment and an allocation —
 * the same choice `age()` above already makes for modified_at, and for
 * the same reason: a raw gig row is what this file's assertions are
 * against, and going through the allocations machinery here would test
 * something this file isn't about.
 */
async function setPaid(gigId: string, amountPaidCents: number) {
  await env.DB.prepare("UPDATE gigs SET amount_paid_cents = ? WHERE id = ?")
    .bind(amountPaidCents, gigId)
    .run();
}

async function clearGigs() {
  await env.DB.prepare("DELETE FROM gigs WHERE user_id = ?").bind(U1).run();
}

beforeAll(async () => {
  await applyMigrations(env.DB);
  await seedUser(env.DB, U1);
  await api(U1, "PUT", `/api/clients/${ACME}`, { name: "Acme Staffing" });
});

beforeEach(clearGigs);

describe("selectNudge", () => {
  it("says nothing when there is nothing to say", async () => {
    expect(await selectNudge(env.DB, U1, NOW)).toBeNull();
  });

  it("raises work that was done and never paid for", async () => {
    await api(U1, "PUT", `/api/gigs/${GIGS.unpaidOld}`, {
      clientId: ACME,
      status: "completed",
      amountOfferedCents: 20000,
    });
    await setPaid(GIGS.unpaidOld, 5000);
    await age(GIGS.unpaidOld, NOW - 20 * DAY);

    const nudge = await selectNudge(env.DB, U1, NOW);
    expect(nudge?.key).toBe(`unpaid:${GIGS.unpaidOld}`);
    expect(nudge?.body).toContain("Acme Staffing");
    expect(nudge?.body).toContain("$150.00");
    expect(nudge?.path).toBe(`/gigs/${GIGS.unpaidOld}`);
  });

  it("raises an unpaid HOURLY gig, which used to be silently worth zero", async () => {
    // An hourly gig has no amount_offered_cents by design — the figure
    // is rate × time — so the nudge saw nothing outstanding and never
    // fired. Silence about money already earned is the one failure this
    // feature exists to prevent.
    await api(U1, "PUT", `/api/gigs/${GIGS.unpaidHourly}`, {
      clientId: ACME,
      status: "completed",
      payType: "hourly",
      hourlyRateCents: 5000,
      durationMinutes: 480,
    });
    await age(GIGS.unpaidHourly, NOW - 20 * DAY);

    const nudge = await selectNudge(env.DB, U1, NOW);
    expect(nudge?.key).toBe(`unpaid:${GIGS.unpaidHourly}`);
    expect(nudge?.body).toContain("$400.00"); // $50/h × 8h
  });

  it("ignores completed work that is actually paid off", async () => {
    await api(U1, "PUT", `/api/gigs/${GIGS.paidOld}`, {
      clientId: ACME,
      status: "completed",
      amountOfferedCents: 10000,
    });
    await setPaid(GIGS.paidOld, 10000);
    await age(GIGS.paidOld, NOW - 60 * DAY);

    expect(await selectNudge(env.DB, U1, NOW)).toBeNull();
  });

  it("leaves recently-touched work alone", async () => {
    await api(U1, "PUT", `/api/gigs/${GIGS.unpaidOld}`, {
      status: "completed",
      amountOfferedCents: 20000,
    });
    await age(GIGS.unpaidOld, NOW - 3 * DAY);

    expect(await selectNudge(env.DB, U1, NOW)).toBeNull();
  });

  it("raises a lead that has gone cold", async () => {
    await api(U1, "PUT", `/api/gigs/${GIGS.staleLead}`, {
      status: "lead",
      location: "Costco on 5th",
    });
    await age(GIGS.staleLead, NOW - 10 * DAY);

    const nudge = await selectNudge(env.DB, U1, NOW);
    expect(nudge?.key).toBe(`lead:${GIGS.staleLead}`);
    expect(nudge?.body).toContain("Costco on 5th");
  });

  // Money already earned beats money that might never be.
  it("prefers unpaid work over a stale lead", async () => {
    await api(U1, "PUT", `/api/gigs/${GIGS.staleLead}`, { status: "lead" });
    await age(GIGS.staleLead, NOW - 30 * DAY);
    await api(U1, "PUT", `/api/gigs/${GIGS.unpaidOld}`, {
      status: "completed",
      amountOfferedCents: 9000,
    });
    await age(GIGS.unpaidOld, NOW - 15 * DAY);

    expect((await selectNudge(env.DB, U1, NOW))?.key).toBe(`unpaid:${GIGS.unpaidOld}`);
  });

  it("picks the longest-outstanding when several qualify", async () => {
    await api(U1, "PUT", `/api/gigs/${GIGS.unpaidOld}`, {
      status: "completed",
      amountOfferedCents: 9000,
    });
    await age(GIGS.unpaidOld, NOW - 15 * DAY);
    await api(U1, "PUT", `/api/gigs/${GIGS.unpaidOlder}`, {
      status: "completed",
      amountOfferedCents: 9000,
    });
    await age(GIGS.unpaidOlder, NOW - 40 * DAY);

    expect((await selectNudge(env.DB, U1, NOW))?.key).toBe(
      `unpaid:${GIGS.unpaidOlder}`,
    );
  });

  // The whole design rests on this: confirmed dated work is already on
  // the calendar with a reminder, so pushing about it is the app
  // competing with itself.
  it("never nudges about confirmed, dated work", async () => {
    await api(U1, "PUT", `/api/gigs/${GIGS.confirmedSoon}`, {
      status: "confirmed",
      dateTime: NOW + 2 * DAY,
      amountOfferedCents: 30000,
    });
    await age(GIGS.confirmedSoon, NOW - 90 * DAY);

    expect(await selectNudge(env.DB, U1, NOW)).toBeNull();
  });

  it("honours custom thresholds", async () => {
    await api(U1, "PUT", `/api/gigs/${GIGS.staleLead}`, { status: "lead" });
    await age(GIGS.staleLead, NOW - 3 * DAY);

    expect(await selectNudge(env.DB, U1, NOW)).toBeNull();
    const eager = await selectNudge(env.DB, U1, NOW, {
      staleLeadDays: 2,
      unpaidDays: 14,
    });
    expect(eager?.key).toBe(`lead:${GIGS.staleLead}`);
  });
});

describe("shouldSend", () => {
  const nudge: Nudge = { key: "unpaid:g1", title: "t", body: "b", path: "/gigs/g1" };

  it("sends when the user has never been nudged", () => {
    expect(shouldSend(nudge, null, null, NOW)).toBe(true);
  });

  it("stays quiet within a day of the last one", () => {
    expect(shouldSend(nudge, "lead:other", NOW - 2 * 60 * 60 * 1000, NOW)).toBe(false);
  });

  it("sends a different fact once a day has passed", () => {
    expect(shouldSend(nudge, "lead:other", NOW - 2 * DAY, NOW)).toBe(true);
  });

  // Repeating the identical fact daily is how an app teaches you to
  // swipe it away unread.
  it("does not repeat the same fact the next day", () => {
    expect(shouldSend(nudge, "unpaid:g1", NOW - 2 * DAY, NOW)).toBe(false);
  });

  it("re-raises the same fact after a week of being ignored", () => {
    expect(shouldSend(nudge, "unpaid:g1", NOW - 8 * DAY, NOW)).toBe(true);
  });
});
