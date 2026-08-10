/// <reference types="@cloudflare/vitest-pool-workers" />
/**
 * Contract tests: the real CalendarClient against a fake Google.
 *
 * calendar-sync.test.ts stubs `CalendarClientLike`, which proves the
 * orchestration rules but skips everything the wire carries. These
 * tests run the unmodified client over `fakeGoogleCalendar`, so what is
 * asserted is the request Google would actually receive — URL, bearer,
 * body shape, RFC3339 timestamps — and how real status codes are read.
 *
 * Gigs arrive through the real `/api/sync` route rather than a repo
 * call, because that is the path a phone uses and the one that stranded
 * gigs in production.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations, seedUser } from "./helpers/db.ts";
import { api } from "./helpers/api.ts";
import { fakeGoogleCalendar } from "./helpers/fake-google-calendar.ts";
import {
  CalendarClient,
  mintAccessToken,
} from "../src/calendar/google-calendar.ts";
import { syncUserGigs } from "../src/calendar/sync-service.ts";
import { UsersRepo } from "../src/repos/users.ts";

const U1 = "user-1";
const ACME = "22222222-cccc-4ccc-8ccc-222222222222";
// 2025-09-10T10:26:40.000Z — a fixed instant so RFC3339 output is exact.
const WHEN = 1757500000000;
const FOUR_H = 4 * 60 * 60 * 1000;

let gigCounter = 0;
/** A fresh uuid-shaped id per gig, so tests never collide. */
function newGigId(): string {
  const n = (++gigCounter).toString(16).padStart(12, "0");
  return `33333333-bbbb-4bbb-8bbb-${n}`;
}

/** Upload a gig the way a phone does: through /api/sync, carrying the
 *  device's own modifiedAt. */
async function uploadGig(
  id: string,
  payload: Record<string, unknown>,
  modifiedAt = Date.now(),
): Promise<void> {
  const res = await api(U1, "POST", "/api/sync", {
    ops: [{ op: "upsert", entity: "gig", id, modifiedAt, payload }],
  });
  expect(res.status).toBe(200);
}

/** Reset the watermark so each test reconciles from scratch. */
async function resetWatermark(): Promise<void> {
  await UsersRepo.for(env.DB).setLastCalendarSyncAt(U1, 0);
}

beforeAll(async () => {
  await applyMigrations(env.DB);
  await seedUser(env.DB, U1);
  await api(U1, "PUT", `/api/clients/${ACME}`, { name: "Acme" });
});

beforeEach(resetWatermark);

describe("CalendarClient against a Google-shaped server", () => {
  it("puts a confirmed gig on the calendar with the fields Google needs", async () => {
    const google = fakeGoogleCalendar();
    const id = newGigId();
    await uploadGig(id, {
      clientId: ACME,
      status: "confirmed",
      location: "Costco on 5th",
      dateTime: WHEN,
      durationMinutes: 90,
      notes: "Bring the long lens",
    });

    const result = await syncUserGigs(
      env.DB,
      U1,
      new CalendarClient("test-access-token", google.fetch),
      Date.now(),
    );

    expect(result.created).toBe(1);
    expect(result.failed).toBe(0);

    const event = google.onlyEvent();
    expect(event.summary).toBe("Acme — Costco on 5th");
    // The venue must be Google's own location field, not just words in
    // the title — that is what offers a map and directions.
    expect(event.location).toBe("Costco on 5th");
    expect(event.description).toContain("Bring the long lens");
    expect(event.description).toContain("Managed by Gigsy");
    // RFC3339, and the duration honoured rather than the 4h default.
    expect(event.start?.dateTime).toBe("2025-09-10T10:26:40.000Z");
    expect(event.end?.dateTime).toBe(
      new Date(WHEN + 90 * 60 * 1000).toISOString(),
    );
    // A gig with travel attached always carries its own reminder; the
    // calendar's default may well be "none".
    expect(event.reminders).toEqual({
      useDefault: false,
      overrides: [{ method: "popup", minutes: 60 }],
    });
  });

  it("sends the bearer token and JSON content type", async () => {
    const google = fakeGoogleCalendar();
    await uploadGig(newGigId(), {
      clientId: ACME,
      status: "confirmed",
      location: "Pier 39",
      dateTime: WHEN,
    });

    await syncUserGigs(
      env.DB,
      U1,
      new CalendarClient("test-access-token", google.fetch),
      Date.now(),
    );

    const post = google.requests.find((r) => r.method === "POST");
    expect(post?.url).toBe(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events",
    );
    expect(post?.authorization).toBe("Bearer test-access-token");
    expect(post?.contentType).toBe("application/json");
  });

  it("counts a wrong access token as failed rather than silently losing the gig", async () => {
    const google = fakeGoogleCalendar({ accessToken: "the-right-one" });
    await uploadGig(newGigId(), {
      clientId: ACME,
      status: "confirmed",
      location: "Nowhere",
      dateTime: WHEN,
    });

    const result = await syncUserGigs(
      env.DB,
      U1,
      new CalendarClient("the-wrong-one", google.fetch),
      Date.now(),
    );

    expect(result.created).toBe(0);
    expect(result.failed).toBe(1);
    expect(google.events.size).toBe(0);
    // A failed run must not advance the watermark, or the gig would be
    // stranded exactly the way the two-clock bug stranded them.
    const user = await UsersRepo.for(env.DB).get(U1);
    expect(user?.lastCalendarSyncAt ?? 0).toBe(0);
  });

  it("falls back to a 4h block when the gig has no duration", async () => {
    const google = fakeGoogleCalendar();
    await uploadGig(newGigId(), {
      clientId: ACME,
      status: "confirmed",
      location: "Union Square",
      dateTime: WHEN,
    });

    await syncUserGigs(
      env.DB,
      U1,
      new CalendarClient("test-access-token", google.fetch),
      Date.now(),
    );

    expect(google.onlyEvent().end?.dateTime).toBe(
      new Date(WHEN + FOUR_H).toISOString(),
    );
  });

  it("omits location entirely when the gig has none", async () => {
    const google = fakeGoogleCalendar();
    await uploadGig(newGigId(), {
      clientId: ACME,
      status: "confirmed",
      location: "",
      dateTime: WHEN,
    });

    await syncUserGigs(
      env.DB,
      U1,
      new CalendarClient("test-access-token", google.fetch),
      Date.now(),
    );

    // Not "" — a blank location renders as a stray empty row in Google.
    const post = google.requests.find((r) => r.method === "POST");
    expect(post?.body).not.toHaveProperty("location");
  });

  it("patches the existing event instead of creating a duplicate", async () => {
    const google = fakeGoogleCalendar();
    const id = newGigId();
    await uploadGig(id, {
      clientId: ACME,
      status: "confirmed",
      location: "Old Venue",
      dateTime: WHEN,
    });
    const client = new CalendarClient("test-access-token", google.fetch);
    await syncUserGigs(env.DB, U1, client, Date.now());
    const eventId = google.onlyEvent().id;

    await resetWatermark();
    await uploadGig(id, {
      clientId: ACME,
      status: "confirmed",
      location: "New Venue",
      dateTime: WHEN,
    });
    const result = await syncUserGigs(env.DB, U1, client, Date.now());

    expect(result.updated).toBe(1);
    expect(result.created).toBe(0);
    // Same event, moved — not a second entry on the user's calendar.
    expect(google.events.size).toBe(1);
    expect(google.onlyEvent().id).toBe(eventId);
    expect(google.onlyEvent().location).toBe("New Venue");
    expect(google.requests.some((r) => r.method === "PATCH")).toBe(true);
  });

  it("removes the event when a gig is demoted back to a lead", async () => {
    const google = fakeGoogleCalendar();
    const id = newGigId();
    await uploadGig(id, {
      clientId: ACME,
      status: "confirmed",
      location: "Maybe Hall",
      dateTime: WHEN,
    });
    const client = new CalendarClient("test-access-token", google.fetch);
    await syncUserGigs(env.DB, U1, client, Date.now());
    expect(google.events.size).toBe(1);

    await resetWatermark();
    await uploadGig(id, {
      clientId: ACME,
      status: "lead",
      location: "Maybe Hall",
      dateTime: WHEN,
    });
    const result = await syncUserGigs(env.DB, U1, client, Date.now());

    expect(result.deleted).toBe(1);
    expect(google.events.size).toBe(0);
  });

  it("treats an event the user already deleted by hand as gone", async () => {
    const google = fakeGoogleCalendar();
    const id = newGigId();
    await uploadGig(id, {
      clientId: ACME,
      status: "confirmed",
      location: "Vanished Hall",
      dateTime: WHEN,
    });
    const client = new CalendarClient("test-access-token", google.fetch);
    await syncUserGigs(env.DB, U1, client, Date.now());
    const eventId = google.onlyEvent().id;

    // The user deletes it in Google's UI, then demotes the gig here.
    const withGone = fakeGoogleCalendar({ goneEventIds: [eventId] });
    await resetWatermark();
    await uploadGig(id, {
      clientId: ACME,
      status: "lead",
      location: "Vanished Hall",
      dateTime: WHEN,
    });
    const result = await syncUserGigs(
      env.DB,
      U1,
      new CalendarClient("test-access-token", withGone.fetch),
      Date.now(),
    );

    // A 404 is success: the desired end state already holds. Counting it
    // as failure would stall the watermark forever.
    expect(result.deleted).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("reports a Google outage as failed and retries the gig next run", async () => {
    const failing = fakeGoogleCalendar({ failCreate: true });
    const id = newGigId();
    await uploadGig(id, {
      clientId: ACME,
      status: "confirmed",
      location: "Flaky Arena",
      dateTime: WHEN,
    });

    const first = await syncUserGigs(
      env.DB,
      U1,
      new CalendarClient("test-access-token", failing.fetch),
      Date.now(),
    );
    expect(first.failed).toBe(1);
    expect(first.created).toBe(0);

    // Watermark held, so the very next run picks the same gig up.
    const recovered = fakeGoogleCalendar();
    const second = await syncUserGigs(
      env.DB,
      U1,
      new CalendarClient("test-access-token", recovered.fetch),
      Date.now(),
    );
    expect(second.created).toBe(1);
    expect(recovered.onlyEvent().location).toBe("Flaky Arena");
  });

  /**
   * The regression that started all this, asserted from outside: a gig
   * edited offline carries the phone's clock, which can sit below the
   * server-stamped watermark. Before `server_modified_at` it never
   * reached Google at all.
   */
  it("syncs a gig uploaded from offline with an hours-old timestamp", async () => {
    const google = fakeGoogleCalendar();
    const client = new CalendarClient("test-access-token", google.fetch);

    // A clean run first, which advances the watermark to server-now.
    await syncUserGigs(env.DB, U1, client, Date.now());

    // The phone drains an edit it made hours ago, while offline.
    await uploadGig(
      newGigId(),
      {
        clientId: ACME,
        status: "confirmed",
        location: "Backstage",
        dateTime: WHEN,
      },
      Date.now() - 5 * 60 * 60 * 1000,
    );

    const result = await syncUserGigs(env.DB, U1, client, Date.now());

    expect(result.created).toBe(1);
    expect(google.onlyEvent().location).toBe("Backstage");
  });

  it("never puts a lead on the calendar", async () => {
    const google = fakeGoogleCalendar();
    await uploadGig(newGigId(), {
      clientId: ACME,
      status: "lead",
      location: "Just an enquiry",
      dateTime: WHEN,
    });

    const result = await syncUserGigs(
      env.DB,
      U1,
      new CalendarClient("test-access-token", google.fetch),
      Date.now(),
    );

    expect(result.created).toBe(0);
    expect(google.events.size).toBe(0);
  });

  it("never puts a confirmed gig with no date on the calendar", async () => {
    const google = fakeGoogleCalendar();
    await uploadGig(newGigId(), {
      clientId: ACME,
      status: "confirmed",
      location: "Date TBC",
      dateTime: null,
    });

    const result = await syncUserGigs(
      env.DB,
      U1,
      new CalendarClient("test-access-token", google.fetch),
      Date.now(),
    );

    expect(result.created).toBe(0);
    expect(google.events.size).toBe(0);
  });
});

describe("mintAccessToken against a Google-shaped token endpoint", () => {
  it("exchanges a refresh token for an access token", async () => {
    const google = fakeGoogleCalendar({
      validRefreshTokens: ["good-token"],
      accessToken: "minted-at",
    });

    const minted = await mintAccessToken({
      refreshToken: "good-token",
      clientId: "cid",
      clientSecret: "csecret",
      fetchFn: google.fetch,
    });

    expect(minted).toEqual({ accessToken: "minted-at" });
    expect(google.requests[0]?.body).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "good-token",
      client_id: "cid",
      client_secret: "csecret",
    });
  });

  it("reads invalid_grant as revoked, not as a transient failure", async () => {
    const google = fakeGoogleCalendar({ validRefreshTokens: ["good-token"] });

    const minted = await mintAccessToken({
      refreshToken: "withdrawn-token",
      clientId: "cid",
      clientSecret: "csecret",
      fetchFn: google.fetch,
    });

    // The distinction matters: "revoked" disconnects the user, null
    // retries. Getting it wrong means retrying forever or disconnecting
    // someone over a blip.
    expect(minted).toBe("revoked");
  });
});
