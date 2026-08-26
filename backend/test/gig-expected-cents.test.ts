/// <reference types="@cloudflare/vitest-pool-workers" />
/**
 * `gigs.expected_cents` — the derived, server-owned column every money
 * total sums (migration 0014).
 *
 * The point of the column is that the aggregates cannot ask
 * domain/gig-pay.ts a question about a row they are summing in SQL.
 * The point of THIS file is that the column keeps saying what that
 * module says. The vectors run against the stored value, not against
 * the function — gig-pay.test.ts already covers the function, and a
 * column that silently stopped tracking it would pass that suite while
 * every report went wrong.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations, seedUser } from "./helpers/db.ts";
import { api } from "./helpers/api.ts";
import vectors from "../../fixtures/gig-pay-vectors.json";
import { GigsRepo, type GigData } from "../src/repos/gigs.ts";
import { GigInput } from "../src/domain/schemas.ts";
import { PAY_TYPES, type PayableGig } from "../src/domain/gig-pay.ts";

const U1 = "expected-user-1";
const G1 = "71111111-1111-4111-8111-111111111111";
const G2 = "72222222-2222-4222-8222-222222222222";

/** The case the write schema refuses; see the vectors describe below. */
const BREAK_LONGER_THAN_SPAN =
  "a break longer than the span clamps at zero rather than going negative";

/** A vector's pay fields, plus the rest of GigData at its emptiest —
 *  none of the others feed the derivation. */
function gigDataFrom(pay: PayableGig): GigData {
  return {
    clientId: null,
    parentGigId: null,
    title: null,
    status: "lead",
    location: null,
    dateTime: null,
    durationMinutes: pay.durationMinutes,
    payType: pay.payType,
    hourlyRateCents: pay.hourlyRateCents,
    workStartedAt: pay.workStartedAt,
    workEndedAt: pay.workEndedAt,
    breakMinutes: pay.breakMinutes,
    amountOfferedCents: pay.amountOfferedCents,
    notes: null,
    source: "manual",
  };
}

async function storedExpectedCents(id: string): Promise<number | null> {
  const row = await env.DB.prepare("SELECT expected_cents AS e FROM gigs WHERE id = ?")
    .bind(id)
    .first<{ e: number | null }>();
  return row?.e ?? null;
}

beforeAll(async () => {
  await applyMigrations(env.DB);
  await seedUser(env.DB, U1);
});

/**
 * Straight through the repo, not the route.
 *
 * One vector — a break longer than the span — is deliberately
 * unreachable through GigInput: its superRefine rejects a break that
 * fills or exceeds the shift, because that is a cancelled gig rather
 * than a zero-paid one. The vector exists anyway, since gig-pay.ts
 * clamps at zero rather than going negative and something has to hold
 * it to that. Driving these through upsert() covers every case
 * including that one, and upsert() is exactly where the derivation
 * happens — the single funnel the CRUD route and /api/sync both use.
 * The describe below then pins the schema's half of that split.
 */
describe("expected_cents against the shared pay vectors", () => {
  for (const c of vectors.cases) {
    it(c.name, async () => {
      const pay = c.gig as PayableGig;
      // Same guard as gig-pay.test.ts: the cast narrows a plain JSON
      // string to the PayType union, so a typo would otherwise price
      // as hourly and pass.
      expect(PAY_TYPES).toContain(pay.payType);

      const result = await GigsRepo.for(env.DB).upsert(U1, G1, gigDataFrom(pay), {
        now: Date.now(),
      });
      expect(result).not.toBe("forbidden");

      expect(await storedExpectedCents(G1)).toBe(c.expectedCents);
    });
  }

  it("only the break-longer-than-span case is refused by the write schema", () => {
    // Pinning the split rather than assuming it. If GigInput is ever
    // relaxed, or a new vector lands that the schema also refuses, this
    // fails and the comment above stops being a stale claim.
    const refused = vectors.cases
      .filter((c) => !GigInput.safeParse(c.gig).success)
      .map((c) => c.name);
    expect(refused).toEqual([BREAK_LONGER_THAN_SPAN]);
  });
});

describe("expected_cents is derived on every write", () => {
  it("stores a computed figure for an hourly gig created through the route", async () => {
    const res = await api(U1, "PUT", `/api/gigs/${G2}`, {
      status: "confirmed",
      payType: "hourly",
      hourlyRateCents: 5000,
      durationMinutes: 480,
    });
    expect(res.status).toBe(201);
    // $50/h × 8h. The gig this whole change exists for: it carries no
    // amount_offered_cents at all, and used to count as nothing.
    expect(((await res.json()) as { expectedCents: number }).expectedCents).toBe(40000);
    expect(await storedExpectedCents(G2)).toBe(40000);
  });

  it("recomputes when the work times change", async () => {
    await api(U1, "PUT", `/api/gigs/${G2}`, {
      status: "confirmed",
      payType: "hourly",
      hourlyRateCents: 5000,
      durationMinutes: 480,
    });
    expect(await storedExpectedCents(G2)).toBe(40000);

    // Six hours actually worked, less a 30 minute break.
    const start = Date.UTC(2026, 8, 12, 9);
    await api(U1, "PUT", `/api/gigs/${G2}`, {
      status: "completed",
      payType: "hourly",
      hourlyRateCents: 5000,
      durationMinutes: 480,
      workStartedAt: start,
      workEndedAt: start + 6 * 60 * 60 * 1000,
      breakMinutes: 30,
    });
    expect(await storedExpectedCents(G2)).toBe(27500);
  });

  it("ignores an expectedCents sent by a client", async () => {
    const res = await api(U1, "PUT", `/api/gigs/${G2}`, {
      status: "confirmed",
      payType: "hourly",
      hourlyRateCents: 5000,
      durationMinutes: 480,
      expectedCents: 999_999,
    });
    expect(res.status).toBe(201);
    expect(await storedExpectedCents(G2)).toBe(40000);
  });

  it("ignores an expectedCents arriving through the offline sync batch", async () => {
    // The path that matters most: /api/sync is the one write an
    // offline client can queue up unattended.
    const res = await api(U1, "POST", "/api/sync", {
      ops: [
        {
          entity: "gig",
          op: "upsert",
          id: G2,
          modifiedAt: Date.now(),
          payload: {
            status: "confirmed",
            payType: "hourly",
            hourlyRateCents: 5000,
            durationMinutes: 480,
            expectedCents: 999_999,
          },
        },
      ],
    });
    expect(res.status).toBe(200);
    expect(await storedExpectedCents(G2)).toBe(40000);
  });

  it("stores the offer for a fixed gig", async () => {
    await api(U1, "PUT", `/api/gigs/${G2}`, {
      status: "confirmed",
      amountOfferedCents: 15000,
    });
    expect(await storedExpectedCents(G2)).toBe(15000);
  });

  it("keeps an hourly override rather than the computed figure", async () => {
    await api(U1, "PUT", `/api/gigs/${G2}`, {
      status: "confirmed",
      payType: "hourly",
      hourlyRateCents: 5000,
      durationMinutes: 480,
      amountOfferedCents: 50000,
    });
    expect(await storedExpectedCents(G2)).toBe(50000);
  });
});
