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

export interface FakeCalendarOptions {
  /** The bearer the client is expected to present; anything else 401s. */
  accessToken?: string;
  /** Force POST /events to fail, to exercise the `failed` counter. */
  failCreate?: boolean;
  /** Event ids that answer 404 — an event the user deleted by hand. */
  goneEventIds?: string[];
  /** Refresh tokens the token endpoint accepts. Anything else is
   *  invalid_grant, which the client must read as "revoked". */
  validRefreshTokens?: string[];
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

const EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
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

    // Google authenticates every Calendar call; so does the fake.
    if (headers.get("authorization") !== `Bearer ${accessToken}`) {
      return json({ error: { code: 401, message: "Invalid Credentials" } }, 401);
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
