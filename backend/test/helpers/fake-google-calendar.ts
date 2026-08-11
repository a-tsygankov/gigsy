/**
 * A fake Google Calendar v3 server, as a `fetch` implementation.
 *
 * The existing calendar tests stub `CalendarClientLike` — the interface
 * *above* the HTTP client — so everything the wire actually carries went
 * untested: the URL, the bearer header, the JSON body shape, RFC3339
 * formatting, and how status codes are interpreted. This double sits
 * below `CalendarClient` instead, so the real client runs unmodified and
 * the assertions are about requests Google would receive.
 *
 * It deliberately enforces Google's contract rather than accepting
 * anything: a missing bearer token is a 401, patching an unknown event
 * is a 404. A double that says yes to everything can't catch a client
 * that asks wrongly.
 */

/** An event as Google stores and returns it. */
export interface FakeEvent {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string };
  end?: { dateTime?: string };
  reminders?: { useDefault?: boolean; overrides?: { method: string; minutes: number }[] };
}

export interface RecordedRequest {
  method: string;
  url: string;
  authorization: string | null;
  contentType: string | null;
  body: unknown;
}

/** One calendar's answer to a freeBusy query. Google returns either
 *  busy ranges or per-calendar errors — never both usefully, and never
 *  an event title, which is the whole reason Phase 12 uses this API. */
export interface FakeFreeBusyCalendar {
  busy?: { start: string; end: string }[];
  errors?: { domain: string; reason: string }[];
}

export interface FakeCalendarOptions {
  /** The bearer the client is expected to present; anything else 401s. */
  accessToken?: string;
  /** Force POST /events to fail, to exercise the `failed` counter. */
  failCreate?: boolean;
  /** Answer every Calendar call the way Google does when the API is not
   *  enabled on the Cloud project — the misconfiguration that made the
   *  whole integration look broken while every other signal said fine. */
  apiDisabled?: boolean;
  /** Event ids that answer 404 — an event the user deleted by hand. */
  goneEventIds?: string[];
  /** Refresh tokens the token endpoint accepts. Anything else is
   *  invalid_grant, which the client must read as "revoked". */
  validRefreshTokens?: string[];
  /** Which calendar this fake serves. Requests for any other calendar
   *  404, so pointing the client at the wrong one is a test failure
   *  rather than silently passing (Phase 11 dedicated calendars). */
  calendarId?: string;
  /** What POST /freeBusy answers, per calendar id (Phase 12). A
   *  calendar the query asks for but this map omits comes back with an
   *  empty busy list, exactly as Google does for a genuinely free one. */
  freeBusy?: Record<string, FakeFreeBusyCalendar>;
  /** Force /freeBusy to fail with this status — 403 is the shape of a
   *  grant that never included calendar.readonly. */
  freeBusyStatus?: number;
}

export interface FakeCalendar {
  /** Drop-in for the `fetchFn` that CalendarClient and mintAccessToken take. */
  fetch: typeof fetch;
  /** Events currently on the calendar, by id. */
  events: Map<string, FakeEvent>;
  /** Every request received, in order — the contract under assertion. */
  requests: RecordedRequest[];
  /** Convenience: the single event, when a test expects exactly one. */
  onlyEvent(): FakeEvent;
}

const CALENDAR_API = "https://www.googleapis.com/calendar/v3/calendars";
const FREEBUSY_URL = "https://www.googleapis.com/calendar/v3/freeBusy";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function fakeGoogleCalendar(options: FakeCalendarOptions = {}): FakeCalendar {
  const accessToken = options.accessToken ?? "test-access-token";
  const gone = new Set(options.goneEventIds ?? []);
  const validRefreshTokens = new Set(
    options.validRefreshTokens ?? ["test-refresh-token"],
  );
  // Google's own ids are email-shaped, so the URL carries them encoded.
  const EVENTS_URL = `${CALENDAR_API}/${encodeURIComponent(options.calendarId ?? "primary")}/events`;
  const events = new Map<string, FakeEvent>();
  const requests: RecordedRequest[] = [];
  let nextId = 0;

  const impl = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    // The token endpoint is handed a URLSearchParams, the Calendar API a
    // JSON string. Both stringify to what the wire would carry, so
    // normalise rather than assuming one shape — assuming `string` made
    // this fake read every token request as an empty form.
    const body = init?.body;
    const rawBody =
      typeof body === "string"
        ? body
        : body instanceof URLSearchParams
          ? body.toString()
          : null;

    // The token endpoint speaks form-encoding, not JSON.
    if (url === TOKEN_URL) {
      const form = new URLSearchParams(rawBody ?? "");
      requests.push({
        method,
        url,
        authorization: null,
        contentType: headers.get("content-type"),
        body: Object.fromEntries(form),
      });
      const refreshToken = form.get("refresh_token") ?? "";
      if (!validRefreshTokens.has(refreshToken)) {
        // Exactly what Google returns for a revoked grant; the client
        // must distinguish this from a transient failure.
        return json({ error: "invalid_grant" }, 400);
      }
      return json({ access_token: accessToken, expires_in: 3599 });
    }

    requests.push({
      method,
      url,
      authorization: headers.get("authorization"),
      contentType: headers.get("content-type"),
      body: rawBody === null ? null : JSON.parse(rawBody),
    });

    if (options.apiDisabled === true) {
      return json(
        {
          error: {
            code: 403,
            message: "Google Calendar API has not been used in project before or it is disabled.",
            errors: [{ reason: "accessNotConfigured", domain: "usageLimits" }],
            status: "PERMISSION_DENIED",
            details: [{ reason: "SERVICE_DISABLED" }],
          },
        },
        403,
      );
    }

    // Google authenticates every Calendar call; so does the fake.
    if (headers.get("authorization") !== `Bearer ${accessToken}`) {
      return json({ error: { code: 401, message: "Invalid Credentials" } }, 401);
    }

    // freeBusy is not scoped to one calendar — the query names them.
    if (url === FREEBUSY_URL && method === "POST") {
      if (options.freeBusyStatus !== undefined) {
        return json(
          { error: { code: options.freeBusyStatus, message: "freeBusy refused" } },
          options.freeBusyStatus,
        );
      }
      const query = JSON.parse(rawBody ?? "{}") as {
        items?: { id?: string }[];
      };
      const calendars: Record<string, FakeFreeBusyCalendar> = {};
      for (const item of query.items ?? []) {
        const id = item.id ?? "";
        // An unlisted calendar is free, not missing — that is what
        // Google returns and what the client must not confuse.
        calendars[id] = options.freeBusy?.[id] ?? { busy: [] };
      }
      return json({
        kind: "calendar#freeBusy",
        timeMin: query["timeMin" as keyof typeof query],
        timeMax: query["timeMax" as keyof typeof query],
        calendars,
      });
    }

    if (url === EVENTS_URL && method === "POST") {
      if (options.failCreate === true) {
        return json({ error: { code: 500, message: "Backend Error" } }, 500);
      }
      const id = `fake-evt-${++nextId}`;
      // `id` last: the server assigns it, and a body that happened to
      // carry one must not be able to overwrite it.
      events.set(id, { ...(JSON.parse(rawBody ?? "{}") as FakeEvent), id });
      return json({ id, status: "confirmed" });
    }

    if (url.startsWith(`${EVENTS_URL}/`)) {
      const id = url.slice(EVENTS_URL.length + 1);
      if (gone.has(id)) {
        return json({ error: { code: 404, message: "Not Found" } }, 404);
      }
      if (method === "PATCH") {
        const existing = events.get(id);
        if (existing === undefined) {
          return json({ error: { code: 404, message: "Not Found" } }, 404);
        }
        const patched = { ...existing, ...(JSON.parse(rawBody ?? "{}") as FakeEvent) };
        events.set(id, patched);
        return json(patched);
      }
      if (method === "DELETE") {
        if (!events.delete(id)) {
          return json({ error: { code: 404, message: "Not Found" } }, 404);
        }
        // Google answers 204 with no body.
        return new Response(null, { status: 204 });
      }
    }

    return json({ error: { code: 404, message: "Not Found" } }, 404);
  };

  return {
    fetch: impl as unknown as typeof fetch,
    events,
    requests,
    onlyEvent(): FakeEvent {
      const all = [...events.values()];
      if (all.length !== 1) {
        throw new Error(`expected exactly 1 event, found ${all.length}`);
      }
      return all[0]!;
    },
  };
}
