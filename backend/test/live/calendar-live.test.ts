/**
 * The live Google Calendar round trip.
 *
 * Everything else in this repo tests calendar sync against a double.
 * This is the only test that proves Google accepts what we send, and it
 * runs the same `mintAccessToken` and `CalendarClient` the worker does —
 * no reimplementation, or it would prove nothing about production.
 *
 * Manual dispatch only (.github/workflows/live-calendar.yml): while the
 * OAuth app is in Testing status Google expires refresh tokens for
 * sensitive scopes after 7 days, so this cannot sit on a schedule.
 *
 * It writes to the test account's primary calendar and deletes what it
 * creates. Never point it at a real person's account.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CalendarClient,
  mintAccessToken,
  type CalendarEventInput,
} from "../../src/calendar/google-calendar.ts";

const EVENTS_URL =
  "https://www.googleapis.com/calendar/v3/calendars/primary/events";

/** Distinctive enough that a leaked event is obvious in the calendar. */
const MARKER = "[gigsy-ci] do not keep";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(
      `${name} is not set. Mint one with scripts/mint-e2e-token.ps1.`,
    );
  }
  return value;
}

let accessToken: string;
let client: CalendarClient;
/** Ids created here, so afterAll can clean up even on failure. */
const created: string[] = [];

/** Read an event back the way a user's calendar would show it. */
async function readEvent(eventId: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${EVENTS_URL}/${eventId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 404 || res.status === 410) return null;
  if (!res.ok) throw new Error(`read failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as Record<string, unknown>;
  // Google keeps cancelled events readable for a while; treat them as gone.
  return body.status === "cancelled" ? null : body;
}

function gigEvent(overrides: Partial<CalendarEventInput> = {}): CalendarEventInput {
  // Well into the future, so a leaked event never clutters "today".
  const start = Date.parse("2099-06-15T18:00:00.000Z");
  return {
    summary: `Acme - ${MARKER}`,
    description: `Created by the Gigsy live test.\n\nManaged by Gigsy`,
    location: "1600 Amphitheatre Parkway, Mountain View, CA",
    startMs: start,
    endMs: start + 90 * 60 * 1000,
    ...overrides,
  };
}

beforeAll(async () => {
  const minted = await mintAccessToken({
    refreshToken: requireEnv("E2E_GOOGLE_REFRESH_TOKEN"),
    clientId: requireEnv("GOOGLE_CLIENT_ID"),
    clientSecret: requireEnv("GOOGLE_CLIENT_SECRET"),
  });

  if (minted === "revoked") {
    throw new Error(
      "Google rejected the refresh token (invalid_grant). While the OAuth " +
        "app is in Testing status these expire after 7 days — re-mint with " +
        "scripts/mint-e2e-token.ps1 and update E2E_GOOGLE_REFRESH_TOKEN.",
    );
  }
  if (minted === null) {
    throw new Error("Could not reach Google to mint an access token.");
  }

  accessToken = minted.accessToken;
  client = new CalendarClient(accessToken);
});

afterAll(async () => {
  // Best-effort: a failed assertion must not leave events behind.
  for (const eventId of created) {
    await fetch(`${EVENTS_URL}/${eventId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    }).catch(() => undefined);
  }
});

describe("live Google Calendar", () => {
  it("creates an event Google stores with the fields we sent", async () => {
    const eventId = await client.createEvent(gigEvent());

    expect(eventId).not.toBeNull();
    created.push(eventId!);

    const stored = await readEvent(eventId!);
    expect(stored).not.toBeNull();
    expect(stored!.summary).toBe(`Acme - ${MARKER}`);
    expect(stored!.location).toBe(
      "1600 Amphitheatre Parkway, Mountain View, CA",
    );
    expect(String(stored!.description)).toContain("Managed by Gigsy");

    // Google normalises the timezone, so compare instants rather than
    // strings: "2099-06-15T18:00:00Z" and "...T20:00:00+02:00" are equal.
    const start = stored!.start as { dateTime?: string };
    const end = stored!.end as { dateTime?: string };
    expect(Date.parse(start.dateTime!)).toBe(Date.parse("2099-06-15T18:00:00.000Z"));
    expect(Date.parse(end.dateTime!) - Date.parse(start.dateTime!)).toBe(
      90 * 60 * 1000,
    );

    // The reminder is the whole reason Phase 7 skipped push for gigs.
    const reminders = stored!.reminders as {
      useDefault?: boolean;
      overrides?: { method: string; minutes: number }[];
    };
    expect(reminders.useDefault).toBe(false);
    expect(reminders.overrides).toEqual([{ method: "popup", minutes: 60 }]);
  });

  it("patches an existing event in place", async () => {
    const eventId = await client.createEvent(gigEvent());
    created.push(eventId!);

    const moved = Date.parse("2099-06-16T09:00:00.000Z");
    const ok = await client.patchEvent(
      eventId!,
      gigEvent({
        summary: `Acme - moved - ${MARKER}`,
        location: "Pier 39, San Francisco, CA",
        startMs: moved,
        endMs: moved + 2 * 60 * 60 * 1000,
      }),
    );
    expect(ok).toBe(true);

    const stored = await readEvent(eventId!);
    expect(stored!.summary).toBe(`Acme - moved - ${MARKER}`);
    expect(stored!.location).toBe("Pier 39, San Francisco, CA");
    expect(Date.parse((stored!.start as { dateTime: string }).dateTime)).toBe(moved);
  });

  it("deletes an event, and treats an already-deleted one as gone", async () => {
    const eventId = await client.createEvent(gigEvent());
    expect(eventId).not.toBeNull();

    expect(await client.deleteEvent(eventId!)).toBe(true);
    expect(await readEvent(eventId!)).toBeNull();

    // Deleting twice must succeed: the desired end state already holds,
    // and a false here would stall the cleanup queue forever.
    expect(await client.deleteEvent(eventId!)).toBe(true);
  });

  it("omits location rather than sending an empty one", async () => {
    const eventId = await client.createEvent(gigEvent({ location: null }));
    created.push(eventId!);

    const stored = await readEvent(eventId!);
    expect(stored!.location).toBeUndefined();
  });
});
