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
  startMs: number;
  endMs: number;
}

function eventBody(event: CalendarEventInput) {
  return {
    summary: event.summary,
    description: event.description,
    start: { dateTime: new Date(event.startMs).toISOString() },
    end: { dateTime: new Date(event.endMs).toISOString() },
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
