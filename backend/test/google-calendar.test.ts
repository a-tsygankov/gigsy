/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect } from "vitest";
import {
  CalendarClient,
  mintAccessToken,
} from "../src/calendar/google-calendar.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("mintAccessToken", () => {
  const opts = {
    refreshToken: "rt-1",
    clientId: "cid",
    clientSecret: "sec",
  };

  it("POSTs the refresh_token grant and returns the access token", async () => {
    let seenUrl = "";
    let seenBody = "";
    const fetchFn = (async (url: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(url);
      seenBody = String(init?.body);
      return jsonResponse({ access_token: "at-9", expires_in: 3599 });
    }) as typeof fetch;

    const result = await mintAccessToken({ ...opts, fetchFn });

    expect(seenUrl).toBe("https://oauth2.googleapis.com/token");
    expect(seenBody).toContain("grant_type=refresh_token");
    expect(seenBody).toContain("refresh_token=rt-1");
    expect(result).toEqual({ accessToken: "at-9" });
  });

  it("flags a revoked token (invalid_grant) distinctly", async () => {
    const fetchFn = (async () =>
      jsonResponse({ error: "invalid_grant" }, 400)) as typeof fetch;
    expect(await mintAccessToken({ ...opts, fetchFn })).toBe("revoked");
  });

  it("returns null on other failures (retryable)", async () => {
    const fetchFn = (async () => new Response("boom", { status: 500 })) as typeof fetch;
    expect(await mintAccessToken({ ...opts, fetchFn })).toBeNull();
  });
});

describe("CalendarClient", () => {
  const EVENT = {
    summary: "Acme — Costco on 5th",
    description: "notes",
    location: "Costco on 5th",
    startMs: 1757500000000,
    endMs: 1757514400000,
    reminderMinutes: 60,
  };

  it("creates an event on the primary calendar with bearer auth", async () => {
    let seenUrl = "";
    let seenAuth = "";
    let seenBody = "";
    const fetchFn = (async (url: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(url);
      seenAuth = new Headers(init?.headers).get("Authorization") ?? "";
      seenBody = String(init?.body);
      return jsonResponse({ id: "evt-1" });
    }) as typeof fetch;

    const client = new CalendarClient("at-9", fetchFn);
    const id = await client.createEvent(EVENT);

    expect(seenUrl).toBe(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events",
    );
    expect(seenAuth).toBe("Bearer at-9");
    const body = JSON.parse(seenBody) as {
      summary: string;
      start: { dateTime: string };
      end: { dateTime: string };
    };
    expect(body.summary).toBe(EVENT.summary);
    expect(body.start.dateTime).toBe(new Date(EVENT.startMs).toISOString());
    expect(body.end.dateTime).toBe(new Date(EVENT.endMs).toISOString());
    expect(id).toBe("evt-1");
  });

  it("patches and deletes by event id; failures return null/false", async () => {
    const calls: string[] = [];
    const fetchFn = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method} ${String(url)}`);
      return init?.method === "DELETE"
        ? new Response(null, { status: 204 })
        : jsonResponse({ id: "evt-1" });
    }) as typeof fetch;

    const client = new CalendarClient("at-9", fetchFn);
    expect(await client.patchEvent("evt-1", EVENT)).toBe(true);
    expect(await client.deleteEvent("evt-1")).toBe(true);
    expect(calls).toEqual([
      "PATCH https://www.googleapis.com/calendar/v3/calendars/primary/events/evt-1",
      "DELETE https://www.googleapis.com/calendar/v3/calendars/primary/events/evt-1",
    ]);

    const failing = new CalendarClient("at-9", (async () =>
      new Response("nope", { status: 403 })) as typeof fetch);
    expect(await failing.createEvent(EVENT)).toBeNull();
    expect(await failing.patchEvent("evt-1", EVENT)).toBe(false);
  });

  it("treats deleting an already-gone event (404/410) as success", async () => {
    const fetchFn = (async () => new Response(null, { status: 410 })) as typeof fetch;
    expect(await new CalendarClient("at", fetchFn).deleteEvent("evt-1")).toBe(true);
  });
});

// The venue used to live only in the event title, so a calendar entry
// offered no map or directions — the thing you actually want when
// you're heading to a booth you've never been to.
describe("CalendarEventInput — location and reminders", () => {
  function capture() {
    const sent: Record<string, unknown>[] = [];
    const fetchFn = (async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ id: "evt-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    return { sent, fetchFn };
  }

  const base = {
    summary: "Acme — Costco on 5th",
    description: "notes",
    startMs: 1757500000000,
    endMs: 1757510000000,
    reminderMinutes: 60,
  };

  it("sends the venue in Google's own location field", async () => {
    const { sent, fetchFn } = capture();
    await new CalendarClient("token", fetchFn).createEvent({
      ...base,
      location: "Costco on 5th, booth 12",
    });
    expect(sent[0]?.["location"]).toBe("Costco on 5th, booth 12");
  });

  it("omits location entirely when the gig has none", async () => {
    const { sent, fetchFn } = capture();
    await new CalendarClient("token", fetchFn).createEvent({
      ...base,
      location: null,
    });
    expect(sent[0]).not.toHaveProperty("location");
  });

  // Phase 7 argued push notifications were unnecessary because the
  // calendar reminds you. That only holds if there IS a reminder — a
  // user whose calendar default is "none" would get silence.
  it("sets an explicit reminder rather than trusting calendar defaults", async () => {
    const { sent, fetchFn } = capture();
    await new CalendarClient("token", fetchFn).createEvent({
      ...base,
      location: null,
    });
    expect(sent[0]?.["reminders"]).toEqual({
      useDefault: false,
      overrides: [{ method: "popup", minutes: 60 }],
    });
  });
});
