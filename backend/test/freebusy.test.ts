/// <reference types="@cloudflare/vitest-pool-workers" />
/**
 * The freebusy client, against a Google-shaped server (Phase 12, Task 3).
 *
 * Phase 6 made the calendar integration one-way on purpose. This is the
 * first read back, and the plan allows it only through `freebusy`,
 * which returns ranges and never titles — so personal event content is
 * never held even momentarily, not even in a variable we forget to
 * clear.
 *
 * The load-bearing test in here is the last one: a calendar that
 * errored must never be read as a calendar with nothing on it. "Free"
 * is the dangerous default, because it is the answer that has the user
 * promising time they do not have.
 */
import { describe, it, expect } from "vitest";
import { fakeGoogleCalendar } from "./helpers/fake-google-calendar.ts";
import { queryFreeBusy } from "../src/calendar/google-calendar.ts";

const TOKEN = "test-access-token";
const MIN = Date.parse("2026-08-10T00:00:00.000Z");
const MAX = Date.parse("2026-08-17T00:00:00.000Z");

const busyAt = (start: string, end: string) => ({ start, end });

async function ask(
  fake: ReturnType<typeof fakeGoogleCalendar>,
  calendarIds = ["primary"],
) {
  return queryFreeBusy({
    accessToken: TOKEN,
    timeMinMs: MIN,
    timeMaxMs: MAX,
    calendarIds,
    fetchFn: fake.fetch,
  });
}

describe("queryFreeBusy — the request Google receives", () => {
  it("POSTs to the freeBusy endpoint with the bearer and a JSON body", async () => {
    const fake = fakeGoogleCalendar();

    await ask(fake);

    const sent = fake.requests.at(-1)!;
    expect(sent.method).toBe("POST");
    expect(sent.url).toBe("https://www.googleapis.com/calendar/v3/freeBusy");
    expect(sent.authorization).toBe(`Bearer ${TOKEN}`);
    expect(sent.contentType).toBe("application/json");
  });

  it("asks for the window in RFC3339, not epoch milliseconds", async () => {
    const fake = fakeGoogleCalendar();

    await ask(fake);

    expect(fake.requests.at(-1)!.body).toMatchObject({
      timeMin: "2026-08-10T00:00:00.000Z",
      timeMax: "2026-08-17T00:00:00.000Z",
    });
  });

  it("names every calendar it wants", async () => {
    const fake = fakeGoogleCalendar();

    await ask(fake, ["primary", "gigsy@group.calendar.google.com"]);

    expect(fake.requests.at(-1)!.body).toMatchObject({
      items: [{ id: "primary" }, { id: "gigsy@group.calendar.google.com" }],
    });
  });

  it("asks only once for a calendar named twice", async () => {
    // calendarTargetId is often "primary" too; asking twice would be
    // harmless to Google and noise to read in a log.
    const fake = fakeGoogleCalendar();

    await ask(fake, ["primary", "primary"]);

    expect(fake.requests.at(-1)!.body).toMatchObject({ items: [{ id: "primary" }] });
  });
});

describe("queryFreeBusy — what comes back", () => {
  it("returns busy ranges as epoch milliseconds", async () => {
    const fake = fakeGoogleCalendar({
      freeBusy: {
        primary: {
          busy: [busyAt("2026-08-10T14:00:00Z", "2026-08-10T16:00:00Z")],
        },
      },
    });

    const result = await ask(fake);

    expect(result).toEqual({
      busy: [
        {
          start: Date.parse("2026-08-10T14:00:00Z"),
          end: Date.parse("2026-08-10T16:00:00Z"),
        },
      ],
    });
  });

  it("returns times and nothing else, even if the server volunteers more", async () => {
    // freebusy does not return titles. This asserts that if it ever
    // did, ours would drop them on the floor rather than carry someone's
    // dentist appointment into the projection.
    const fake = fakeGoogleCalendar({
      freeBusy: {
        primary: {
          busy: [
            {
              ...busyAt("2026-08-10T14:00:00Z", "2026-08-10T16:00:00Z"),
              summary: "Dentist",
              description: "root canal",
            } as never,
          ],
        },
      },
    });

    const result = await ask(fake);

    expect(JSON.stringify(result)).not.toContain("Dentist");
    expect(JSON.stringify(result)).not.toContain("root canal");
    expect(Object.keys((result as { busy: object[] }).busy[0]!).sort()).toEqual([
      "end",
      "start",
    ]);
  });

  it("combines the calendars it asked about", async () => {
    const fake = fakeGoogleCalendar({
      freeBusy: {
        primary: { busy: [busyAt("2026-08-10T14:00:00Z", "2026-08-10T16:00:00Z")] },
        "gigsy@g": { busy: [busyAt("2026-08-11T09:00:00Z", "2026-08-11T10:00:00Z")] },
      },
    });

    const result = await ask(fake, ["primary", "gigsy@g"]);

    expect((result as { busy: unknown[] }).busy).toHaveLength(2);
  });

  it("reports a genuinely empty calendar as free", async () => {
    const fake = fakeGoogleCalendar({ freeBusy: { primary: { busy: [] } } });

    expect(await ask(fake)).toEqual({ busy: [] });
  });

  it("skips a range it cannot read the dates of", async () => {
    // A NaN would propagate into the projection and quietly poison
    // every comparison it touched.
    const fake = fakeGoogleCalendar({
      freeBusy: {
        primary: {
          busy: [
            busyAt("not-a-date", "also-not"),
            busyAt("2026-08-10T14:00:00Z", "2026-08-10T16:00:00Z"),
          ],
        },
      },
    });

    const result = await ask(fake);

    expect((result as { busy: unknown[] }).busy).toHaveLength(1);
  });
});

describe("queryFreeBusy — when it cannot answer", () => {
  it("calls a 403 insufficient scope, so the UI can re-prompt", async () => {
    // A grant that only ever covered calendar.events looks exactly like
    // this, and it is a different problem from Google being down.
    const fake = fakeGoogleCalendar({ freeBusyStatus: 403 });

    expect(await ask(fake)).toBe("insufficient-scope");
  });

  it("calls a 401 insufficient scope too", async () => {
    const fake = fakeGoogleCalendar({ freeBusyStatus: 401 });

    expect(await ask(fake)).toBe("insufficient-scope");
  });

  it("returns null on a server error rather than an empty calendar", async () => {
    const fake = fakeGoogleCalendar({ freeBusyStatus: 500 });

    expect(await ask(fake)).toBeNull();
  });

  it("returns null when the network throws", async () => {
    const result = await queryFreeBusy({
      accessToken: TOKEN,
      timeMinMs: MIN,
      timeMaxMs: MAX,
      calendarIds: ["primary"],
      fetchFn: () => Promise.reject(new Error("offline")),
    });

    expect(result).toBeNull();
  });

  it("NEVER reads a calendar that errored as a calendar that is free", async () => {
    // The one that matters. Google answers 200 with a per-calendar
    // error, so a client that only checks the status code sees an empty
    // busy list and offers the whole week. That is the single worst
    // outcome this feature has: the user promises time they do not have.
    const fake = fakeGoogleCalendar({
      freeBusy: {
        primary: { errors: [{ domain: "global", reason: "notFound" }] },
      },
    });

    expect(await ask(fake)).toBeNull();
  });

  it("still answers when one of several calendars errored", async () => {
    // Partial knowledge is better than none, as long as what IS known
    // is subtracted. The alternative — refusing outright — would drop a
    // working primary calendar because a stale secondary went away.
    const fake = fakeGoogleCalendar({
      freeBusy: {
        primary: { busy: [busyAt("2026-08-10T14:00:00Z", "2026-08-10T16:00:00Z")] },
        stale: { errors: [{ domain: "global", reason: "notFound" }] },
      },
    });

    const result = await ask(fake, ["primary", "stale"]);

    expect((result as { busy: unknown[] }).busy).toHaveLength(1);
  });

  it("returns null when the body is not the shape Google documents", async () => {
    const result = await queryFreeBusy({
      accessToken: TOKEN,
      timeMinMs: MIN,
      timeMaxMs: MAX,
      calendarIds: ["primary"],
      fetchFn: () =>
        Promise.resolve(new Response("not json at all", { status: 200 })),
    });

    expect(result).toBeNull();
  });
});
