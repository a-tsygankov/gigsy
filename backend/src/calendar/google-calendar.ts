/**
 * Thin Google Calendar API wrapper (docs/plan.md §9). One access
 * token per sync run, minted from the user's decrypted refresh token
 * via the refresh_token grant. "revoked" (invalid_grant) is a
 * distinct outcome — the caller disconnects the user instead of
 * retrying forever. fetch injected throughout.
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3/calendars";
const FREEBUSY_URL = "https://www.googleapis.com/calendar/v3/freeBusy";

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

/**
 * When the user is busy, as ranges — the only read Gigsy ever makes
 * back out of Google (Phase 12).
 *
 * Phase 6 made the integration one-way deliberately, and this reverses
 * the direction for reads only: nothing here ever modifies an event.
 * `freebusy` is the API the plan allows because it returns times and
 * never titles, so personal event content is not held even for the
 * length of a request. The mapping below keeps that true even if
 * Google someday volunteers more: only `start` and `end` are read.
 *
 * The outcomes are deliberately three, not two:
 * - `{ busy }`  — an answer, possibly an empty one
 * - `"insufficient-scope"` — the grant never covered calendar.readonly,
 *   which the UI can fix by asking; distinct from a transient failure
 * - `null` — we do not know
 *
 * "We do not know" must never collapse into "free". Offering a slot
 * the user cannot work is the one outcome worse than no page at all,
 * so every uncertain path below returns null.
 */
export interface FreeBusyRange {
  start: number;
  end: number;
}

export type FreeBusyResult =
  | { busy: FreeBusyRange[] }
  | "insufficient-scope"
  | null;

interface FreeBusyBody {
  calendars?: Record<
    string,
    { busy?: { start?: string; end?: string }[]; errors?: unknown[] }
  >;
}

export async function queryFreeBusy(options: {
  accessToken: string;
  timeMinMs: number;
  timeMaxMs: number;
  calendarIds: string[];
  fetchFn?: typeof fetch;
}): Promise<FreeBusyResult> {
  const fetchFn = options.fetchFn ?? fetch.bind(globalThis);
  // calendarTargetId is frequently "primary" as well; asking twice is
  // harmless to Google and noise to read back.
  const wanted = [...new Set(options.calendarIds)];
  if (wanted.length === 0) return { busy: [] };

  try {
    const res = await fetchFn(FREEBUSY_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        timeMin: new Date(options.timeMinMs).toISOString(),
        timeMax: new Date(options.timeMaxMs).toISOString(),
        items: wanted.map((id) => ({ id })),
      }),
    });

    // A grant limited to calendar.events answers exactly like this, and
    // it is a problem the user can fix — unlike Google being down.
    if (res.status === 401 || res.status === 403) return "insufficient-scope";
    if (!res.ok) return null;

    const body = (await res.json()) as FreeBusyBody;
    const calendars = body.calendars;
    if (typeof calendars !== "object" || calendars === null) return null;

    const busy: FreeBusyRange[] = [];
    let answered = 0;

    for (const id of wanted) {
      const calendar = calendars[id];
      if (calendar === undefined) continue;
      // Google reports a per-calendar failure INSIDE a 200. Counting
      // that as "nothing on it" is how a client offers a whole week it
      // never actually checked.
      if (Array.isArray(calendar.errors) && calendar.errors.length > 0) continue;

      answered++;
      for (const range of calendar.busy ?? []) {
        const start = Date.parse(range.start ?? "");
        const end = Date.parse(range.end ?? "");
        // An unparseable bound would become NaN and quietly poison
        // every comparison downstream.
        if (Number.isNaN(start) || Number.isNaN(end)) continue;
        busy.push({ start, end });
      }
    }

    // Nothing we asked about actually answered — that is ignorance, not
    // availability. Partial knowledge still counts: one stale secondary
    // calendar should not discard a working primary.
    if (answered === 0) return null;

    return { busy };
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
