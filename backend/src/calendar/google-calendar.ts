/**
 * Thin Google Calendar API wrapper (docs/plan.md §9). One access
 * token per sync run, minted from the user's decrypted refresh token
 * via the refresh_token grant. "revoked" (invalid_grant) is a
 * distinct outcome — the caller disconnects the user instead of
 * retrying forever. fetch injected throughout.
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const PRIMARY_EVENTS_URL =
  "https://www.googleapis.com/calendar/v3/calendars/primary/events";

export interface MintOptions {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  fetchFn?: typeof fetch;
}

export async function mintAccessToken(
  options: MintOptions,
): Promise<{ accessToken: string } | "revoked" | null> {
  const fetchFn = options.fetchFn ?? fetch.bind(globalThis);
  try {
    const res = await fetchFn(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: options.refreshToken,
        client_id: options.clientId,
        client_secret: options.clientSecret,
      }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return body.error === "invalid_grant" ? "revoked" : null;
    }
    const body = (await res.json()) as { access_token?: string };
    return typeof body.access_token === "string"
      ? { accessToken: body.access_token }
      : null;
  } catch {
    return null;
  }
}

export interface CalendarEventInput {
  summary: string;
  description: string;
  /** The venue, sent as Google's own location field so the entry
   * offers a map and directions — not just words in the title. */
  location: string | null;
  startMs: number;
  endMs: number;
}

/** Gigs are paid work with travel attached, so an event always carries
 * a reminder rather than inheriting the calendar's default — which may
 * well be "none". The Phase 7 decision to skip push notifications
 * assumed the calendar would remind you; this is what makes that true. */
const REMINDER_MINUTES_BEFORE = 60;

function eventBody(event: CalendarEventInput) {
  return {
    summary: event.summary,
    description: event.description,
    // Omitted rather than sent empty: a blank location field renders
    // as a stray empty row in Google's UI.
    ...(event.location !== null && event.location !== ""
      ? { location: event.location }
      : {}),
    start: { dateTime: new Date(event.startMs).toISOString() },
    end: { dateTime: new Date(event.endMs).toISOString() },
    reminders: {
      useDefault: false,
      overrides: [{ method: "popup", minutes: REMINDER_MINUTES_BEFORE }],
    },
  };
}

export class CalendarClient {
  constructor(
    private readonly accessToken: string,
    private readonly fetchFn: typeof fetch = fetch.bind(globalThis),
  ) {}

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.accessToken}`,
      "content-type": "application/json",
    };
  }

  /** Returns the created event id, null on failure. */
  async createEvent(event: CalendarEventInput): Promise<string | null> {
    try {
      const res = await this.fetchFn(PRIMARY_EVENTS_URL, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(eventBody(event)),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { id?: string };
      return typeof body.id === "string" ? body.id : null;
    } catch {
      return null;
    }
  }

  async patchEvent(eventId: string, event: CalendarEventInput): Promise<boolean> {
    try {
      const res = await this.fetchFn(`${PRIMARY_EVENTS_URL}/${eventId}`, {
        method: "PATCH",
        headers: this.headers(),
        body: JSON.stringify(eventBody(event)),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Already-gone events (404/410) count as deleted. */
  async deleteEvent(eventId: string): Promise<boolean> {
    try {
      const res = await this.fetchFn(`${PRIMARY_EVENTS_URL}/${eventId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${this.accessToken}` },
      });
      return res.ok || res.status === 404 || res.status === 410;
    } catch {
      return false;
    }
  }
}
