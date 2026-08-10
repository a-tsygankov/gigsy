/**
 * Thin Google Calendar API wrapper (docs/plan.md §9). One access
 * token per sync run, minted from the user's decrypted refresh token
 * via the refresh_token grant. "revoked" (invalid_grant) is a
 * distinct outcome — the caller disconnects the user instead of
 * retrying forever. fetch injected throughout.
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3/calendars";

/** Events URL for a calendar id. "primary" is the user's main one; a
 *  dedicated Gigsy calendar supplies its own id (Phase 11). The id is
 *  URL-encoded because a calendar id is an email-shaped string. */
function eventsUrl(calendarId: string): string {
  return `${CALENDAR_API}/${encodeURIComponent(calendarId)}/events`;
}

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
  /** Minutes before the start to remind, or null to inherit whatever
   *  the user's calendar already does. Phase 11 made this a setting:
   *  someone who curates their own defaults should be able to opt out
   *  rather than have ours stacked on top. */
  reminderMinutes: number | null;
}

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
    // Gigs are paid work with travel attached, so by default an event
    // carries its own reminder rather than inheriting a calendar whose
    // default may well be "none" — the Phase 7 decision to skip push
    // for gigs assumed the calendar would remind you.
    reminders:
      event.reminderMinutes === null
        ? { useDefault: true }
        : {
            useDefault: false,
            overrides: [{ method: "popup", minutes: event.reminderMinutes }],
          },
  };
}

/**
 * Creates a calendar and returns its id, or "insufficient-scope" when
 * the stored grant only covers events.
 *
 * Separate from CalendarClient because it is bound to no calendar — it
 * makes one. The scope distinction matters: `calendar.events` is what
 * connecting asks for, and creating a calendar needs the broader
 * `calendar`. Reporting that as its own outcome lets the UI re-prompt
 * for consent instead of showing "something went wrong".
 */
export async function createCalendar(
  accessToken: string,
  summary: string,
  fetchFn: typeof fetch = fetch.bind(globalThis),
): Promise<string | "insufficient-scope" | null> {
  try {
    const res = await fetchFn(CALENDAR_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ summary }),
    });
    if (res.status === 403 || res.status === 401) return "insufficient-scope";
    if (!res.ok) return null;
    const body = (await res.json()) as { id?: string };
    return typeof body.id === "string" ? body.id : null;
  } catch {
    return null;
  }
}

export class CalendarClient {
  private readonly eventsUrl: string;

  constructor(
    private readonly accessToken: string,
    private readonly fetchFn: typeof fetch = fetch.bind(globalThis),
    calendarId = "primary",
  ) {
    this.eventsUrl = eventsUrl(calendarId);
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.accessToken}`,
      "content-type": "application/json",
    };
  }

  /** Returns the created event id, null on failure. */
  async createEvent(event: CalendarEventInput): Promise<string | null> {
    try {
      const res = await this.fetchFn(this.eventsUrl, {
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
      const res = await this.fetchFn(`${this.eventsUrl}/${eventId}`, {
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
      const res = await this.fetchFn(`${this.eventsUrl}/${eventId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${this.accessToken}` },
      });
      return res.ok || res.status === 404 || res.status === 410;
    } catch {
      return false;
    }
  }
}
