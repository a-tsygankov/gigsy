/// <reference types="@cloudflare/vitest-pool-workers" />
/**
 * GET /api/a/:token — the public availability endpoint (Phase 12).
 *
 * The first describe block below is the one the plan says must never
 * be deleted. Everything else in this phase is a convenience; that
 * block is the reason the feature was allowed to exist. It seeds a
 * user whose gigs carry a client, a location, an amount and notes,
 * and asserts that a stranger holding the link learns none of them.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { env, SELF } from "cloudflare:test";
import { applyMigrations, seedUser } from "./helpers/db.ts";
import { AvailabilityTokenStore } from "../src/repos/availability-tokens.ts";
import { makeAvailabilityRouter } from "../src/routes/availability.ts";
import { fixedWindowLimiter } from "../src/lib/rate-limit.ts";
import type { PublicAvailability } from "../src/services/availability.ts";

const U1 = "avail-route-user-1";
const EMAIL = "avail-route-one@example.com";
const HOUR = 60 * 60 * 1000;

/** Deliberately distinctive, so a substring search cannot miss them. */
const CLIENT_NAME = "Wharfside Talent Agency";
const CLIENT_ID = "avail-client-marker";
const LOCATION = "Pier 39, San Francisco";
const NOTES = "bring the good camera";
const AMOUNT_CENTS = 250_000;
const CONFIRMED_GIG_ID = "avail-gig-confirmed-marker";
const LEAD_GIG_ID = "avail-gig-lead-marker";

/**
 * Round the clock, every day, for one week.
 *
 * The projection's own rules — working hours, weekends, DST, minimum
 * slot length — are covered directly in availability.test.ts. Flattening
 * them here leaves exactly one thing under test: that a confirmed gig
 * is subtracted and a lead is not, whenever the suite happens to run.
 */
const ALWAYS_OPEN = JSON.stringify({
  availabilityDisplayName: "Andrey",
  availabilityTimeZone: "UTC",
  availabilityWorkingWeek: Array.from({ length: 7 }, () => ({
    startMinute: 0,
    endMinute: 1440,
  })),
  availabilityHorizonWeeks: 1,
  availabilityMinSlotMinutes: 30,
});

/** Fixed at seed time so the assertions and the fixture agree. */
const NOW = Date.now();
const CONFIRMED_START = NOW + 26 * HOUR;
const CONFIRMED_END = CONFIRMED_START + 2 * HOUR;
const LEAD_START = NOW + 50 * HOUR;
const LEAD_END = LEAD_START + 2 * HOUR;

async function insertGig(
  id: string,
  status: string,
  dateTime: number,
  durationMinutes: number,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO gigs (id, user_id, client_id, status, location, date_time,
       duration_minutes, amount_offered_cents, notes, source,
       created_at, modified_at, server_modified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?)`,
  )
    .bind(
      id,
      U1,
      CLIENT_ID,
      status,
      LOCATION,
      dateTime,
      durationMinutes,
      AMOUNT_CENTS,
      NOTES,
      NOW,
      NOW,
      NOW,
    )
    .run();
}

beforeAll(async () => {
  await applyMigrations(env.DB);
  await seedUser(env.DB, U1, EMAIL);

  await env.DB.prepare("UPDATE users SET settings_json = ? WHERE id = ?")
    .bind(ALWAYS_OPEN, U1)
    .run();

  await env.DB.prepare(
    "INSERT INTO clients (id, user_id, name, created_at, modified_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(CLIENT_ID, U1, CLIENT_NAME, NOW, NOW)
    .run();

  await insertGig(CONFIRMED_GIG_ID, "confirmed", CONFIRMED_START, 120);
  await insertGig(LEAD_GIG_ID, "lead", LEAD_START, 120);
});

async function issueLink(ttlMs: number | null = null): Promise<string> {
  return AvailabilityTokenStore.for(env.DB).issue(U1, Date.now(), ttlMs);
}

/** No Authorization header anywhere — that is the point of the route. */
const fetchLink = (token: string): Promise<Response> =>
  SELF.fetch(`https://localhost/api/a/${token}`);

const overlaps = (
  slots: { start: number; end: number }[],
  range: { start: number; end: number },
): boolean => slots.some((s) => s.start < range.end && s.end > range.start);

/**
 * THE TEST THAT MUST NEVER BE DELETED.
 *
 * If a future change makes one of these fail, the change is wrong —
 * not the test. The whole feature is a promise that this endpoint
 * cannot say who you work for, where, or for how much.
 */
describe("GET /api/a/:token — what a stranger can learn", () => {
  it("returns these fields and no others", async () => {
    const res = await fetchLink(await issueLink());
    expect(res.status).toBe(200);

    const body = (await res.json()) as PublicAvailability;

    // An exact key set, not a subset: this is what makes the amount,
    // the client id and every future column unreachable by
    // construction rather than by remembering to omit them.
    //
    // `basedOn` was added in Task 3 and had to pass through here to get
    // in — which is the point of the assertion. It carries whether the
    // user's calendar was read, never anything that was on it, and the
    // plan requires the page to say which it is: silently offering
    // slots the user cannot work is worse than saying "gigs only".
    expect(Object.keys(body).sort()).toEqual([
      "basedOn",
      "displayName",
      "generatedAt",
      "horizonEndsAt",
      "slots",
      "timeZone",
    ]);
  });

  it("gives each slot a start and an end and nothing else", async () => {
    const res = await fetchLink(await issueLink());
    const body = (await res.json()) as PublicAvailability;

    expect(body.slots.length).toBeGreaterThan(0);
    for (const slot of body.slots) {
      expect(Object.keys(slot).sort()).toEqual(["end", "start"]);
    }
  });

  it("never names the client, the place, the notes or any id", async () => {
    const res = await fetchLink(await issueLink());
    const raw = await res.text();

    for (const secret of [
      CLIENT_NAME,
      CLIENT_ID,
      LOCATION,
      NOTES,
      CONFIRMED_GIG_ID,
      LEAD_GIG_ID,
      U1,
      EMAIL,
    ]) {
      expect(raw).not.toContain(secret);
    }
  });

  it("returns free ranges, never busy ones", async () => {
    // "Busy 14:00-18:00" is one join away from a competitor knowing a
    // schedule. The gig's own interval must appear nowhere.
    const res = await fetchLink(await issueLink());
    const body = (await res.json()) as PublicAvailability;

    expect(
      body.slots.some((s) => s.start === CONFIRMED_START && s.end === CONFIRMED_END),
    ).toBe(false);
    expect(overlaps(body.slots, { start: CONFIRMED_START, end: CONFIRMED_END })).toBe(
      false,
    );
  });

  it("says nothing about how busy the user is beyond the free time itself", async () => {
    const res = await fetchLink(await issueLink());
    const body = (await res.json()) as Record<string, unknown>;

    // No counts, no totals — a "3 gigs this week" would tell an agency
    // how much competition it has.
    for (const key of Object.keys(body)) {
      expect(key).not.toMatch(/count|total|gig|client|amount|location/i);
    }
  });

  it("shows only the display name the user chose", async () => {
    const res = await fetchLink(await issueLink());
    const body = (await res.json()) as PublicAvailability;

    expect(body.displayName).toBe("Andrey");
  });
});

describe("GET /api/a/:token — what it counts as busy", () => {
  it("subtracts a confirmed gig", async () => {
    const body = (await (await fetchLink(await issueLink())).json()) as PublicAvailability;

    expect(overlaps(body.slots, { start: CONFIRMED_START, end: CONFIRMED_END })).toBe(
      false,
    );
  });

  it("does not let a lead block anything", async () => {
    // A lead is not yet a commitment; blocking on one would have the
    // user turning down work for a job they have not been given.
    const body = (await (await fetchLink(await issueLink())).json()) as PublicAvailability;

    expect(overlaps(body.slots, { start: LEAD_START, end: LEAD_END })).toBe(true);
  });

  it("never offers the past", async () => {
    const body = (await (await fetchLink(await issueLink())).json()) as PublicAvailability;

    for (const slot of body.slots) {
      expect(slot.start).toBeGreaterThanOrEqual(body.generatedAt);
    }
  });

  it("opens the window on the quarter hour, not on the current minute", async () => {
    // "Free from 15:59" is arithmetically right and reads as broken,
    // because that boundary is an artefact of when the page was loaded
    // rather than anything about the schedule. Rounding up is the only
    // safe direction — down would offer time that has already gone.
    //
    // Boundaries made by actual bookings are deliberately NOT rounded:
    // a gig that ends at 16:45 means free from 16:45, and tidying that
    // would throw away real information to look neater.
    const body = (await (await fetchLink(await issueLink())).json()) as PublicAvailability;

    expect(body.slots[0]!.start % (15 * 60 * 1000)).toBe(0);
    expect(body.slots[0]!.start).toBeGreaterThanOrEqual(body.generatedAt);
  });

  it("runs to the end of a local day, not to a ragged instant", async () => {
    // "Four weeks" means whole days to a reader; ending mid-afternoon
    // on an arbitrary date is a number, not an answer.
    const body = (await (await fetchLink(await issueLink())).json()) as PublicAvailability;

    // The fixture's zone is UTC, so a local midnight is a UTC one.
    expect(body.horizonEndsAt % (24 * 60 * 60 * 1000)).toBe(0);
  });

  it("stops at the horizon it reports", async () => {
    const body = (await (await fetchLink(await issueLink())).json()) as PublicAvailability;

    for (const slot of body.slots) {
      expect(slot.end).toBeLessThanOrEqual(body.horizonEndsAt);
    }
  });
});

describe("GET /api/a/:token — the link itself", () => {
  it("needs no authentication", async () => {
    const res = await fetchLink(await issueLink());

    expect(res.status).toBe(200);
  });

  it("answers 404 for a token that never existed", async () => {
    expect((await fetchLink("nope-not-a-token")).status).toBe(404);
  });

  it("answers 404 once revoked, not 401 or 403", async () => {
    // A 401 would confirm the link had once been real, which tells the
    // holder something about the user's relationship with them.
    const token = await issueLink();
    await AvailabilityTokenStore.for(env.DB).revokeAll(U1, Date.now());

    expect((await fetchLink(token)).status).toBe(404);
  });

  it("answers 404 once expired", async () => {
    const token = await issueLink(-1);

    expect((await fetchLink(token)).status).toBe(404);
  });

  it("stops working the moment a new link is issued", async () => {
    const old = await issueLink();
    await issueLink();

    expect((await fetchLink(old)).status).toBe(404);
  });

  it("tells crawlers and caches to stay out, on success and on failure", async () => {
    // A shared link is not a published one.
    const ok = await fetchLink(await issueLink());
    expect(ok.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(ok.headers.get("Cache-Control")).toBe("no-store");

    const missing = await fetchLink("nope-not-a-token");
    expect(missing.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(missing.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("GET /api/a/:token — rate limiting", () => {
  /** Its own limiter, so the budget here cannot affect the tests
   *  above (or theirs, this one). */
  function appWithLimit(limit: number) {
    return new Hono().route(
      "/api/a",
      makeAvailabilityRouter(fixedWindowLimiter({ limit, windowMs: 60_000 })),
    );
  }

  it("refuses a caller hammering the link", async () => {
    const app = appWithLimit(1);
    const token = await issueLink();
    const url = `https://localhost/api/a/${token}`;

    const first = await app.fetch(new Request(url), env);
    const second = await app.fetch(new Request(url), env);

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(Number(second.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("counts a request for a token that does not exist", async () => {
    // Otherwise guessing tokens is free, and the 128 bits are the only
    // thing protecting the page.
    const app = appWithLimit(1);

    const first = await app.fetch(new Request("https://localhost/api/a/guess-1"), env);
    const second = await app.fetch(new Request("https://localhost/api/a/guess-2"), env);

    expect(first.status).toBe(404);
    expect(second.status).toBe(429);
  });

  it("keeps callers in separate buckets", async () => {
    const app = appWithLimit(1);
    const url = `https://localhost/api/a/${await issueLink()}`;
    const from = (ip: string) =>
      app.fetch(new Request(url, { headers: { "CF-Connecting-IP": ip } }), env);

    expect((await from("203.0.113.1")).status).toBe(200);
    expect((await from("203.0.113.2")).status).toBe(200);
    expect((await from("203.0.113.1")).status).toBe(429);
  });
});
