/**
 * Narrowing and ordering the gig list.
 *
 * `now` is a parameter rather than a clock read so "hide past" is the
 * same assertion at 23:58 as at noon — the boundary is local midnight,
 * which is exactly the value a real clock makes hard to test.
 *
 * The two asymmetries worth stating up front, because they look like
 * bugs until you know why: an undated gig SURVIVES "hide past" (a
 * dateless lead is live work, not history) but is EXCLUDED by a date
 * range (asking what's on that week cannot be answered with something
 * that has no date), and undated gigs sort LAST, not first.
 */
import { describe, it, expect } from "vitest";
import type { Gig, GigStatus } from "./types.ts";
import {
  DEFAULT_FILTERS,
  applyGigFilters,
  dateInputToMs,
  filtersFromSettings,
  hasFilterParams,
  isFiltered,
  msToDateInput,
  parseGigFilters,
  settingsPatchFromFilters,
  toSearchParams,
  type GigFilters,
  type SettingsView,
} from "./gig-filters.ts";

const NOW = new Date(2026, 7, 10, 14, 30).getTime();
const START_OF_TODAY = new Date(2026, 7, 10).getTime();
const END_OF_TODAY = new Date(2026, 7, 10, 23, 59, 59, 999).getTime();
const YESTERDAY = new Date(2026, 7, 9, 18, 0).getTime();
const EARLIER_TODAY = new Date(2026, 7, 10, 9, 0).getTime();
const TOMORROW = new Date(2026, 7, 11, 10, 0).getTime();
const NEXT_WEEK = new Date(2026, 7, 17, 12, 0).getTime();

function gig(id: string, over: Partial<Gig> = {}): Gig {
  return {
    id,
    clientId: null,
    parentGigId: null,
    title: null,
    status: "lead",
    location: null,
    dateTime: null,
    durationMinutes: null,
    payType: "fixed",
    hourlyRateCents: null,
    workStartedAt: null,
    workEndedAt: null,
    breakMinutes: null,
    calendarEventId: null,
    amountOfferedCents: null,
    amountPaidCents: null,
    expectedCents: null,
    notes: null,
    source: null,
    createdAt: 0,
    modifiedAt: 0,
    ...over,
  };
}

const CLIENTS = new Map([
  ["c1", "Acme Promotions"],
  ["c2", "Bright Foods"],
]);

function filters(over: Partial<GigFilters> = {}): GigFilters {
  return { ...DEFAULT_FILTERS, ...over };
}

function ids(list: readonly Gig[]): string[] {
  return list.map((g) => g.id);
}

function apply(gigs: readonly Gig[], over: Partial<GigFilters> = {}): Gig[] {
  return applyGigFilters(gigs, filters(over), CLIENTS, NOW);
}

describe("status filter", () => {
  const gigs = [
    gig("lead", { status: "lead" }),
    gig("confirmed", { status: "confirmed" }),
    gig("completed", { status: "completed" }),
    gig("cancelled", { status: "cancelled" }),
  ];

  it("keeps everything when nothing is selected", () => {
    expect(ids(apply(gigs))).toEqual(["lead", "confirmed", "completed", "cancelled"]);
  });

  it("keeps only the selected status", () => {
    expect(ids(apply(gigs, { statuses: ["confirmed"] }))).toEqual(["confirmed"]);
  });

  it("keeps the union of several statuses", () => {
    expect(ids(apply(gigs, { statuses: ["lead", "cancelled"] }))).toEqual(["lead", "cancelled"]);
  });
});

describe("hide past", () => {
  const gigs = [
    gig("yesterday", { dateTime: YESTERDAY }),
    gig("earlier-today", { dateTime: EARLIER_TODAY }),
    gig("tomorrow", { dateTime: TOMORROW }),
    gig("undated"),
  ];

  it("drops gigs dated before today started", () => {
    expect(ids(apply(gigs, { hidePast: true }))).not.toContain("yesterday");
  });

  it("keeps something earlier today, even though it has already happened", () => {
    expect(ids(apply(gigs, { hidePast: true }))).toContain("earlier-today");
  });

  it("keeps undated gigs — a dateless lead is not history", () => {
    expect(ids(apply(gigs, { hidePast: true }))).toContain("undated");
  });

  it("keeps everything when off", () => {
    expect(ids(apply(gigs))).toHaveLength(4);
  });

  it("treats a gig at exactly midnight as today", () => {
    const midnight = [gig("midnight", { dateTime: START_OF_TODAY })];
    expect(ids(apply(midnight, { hidePast: true }))).toEqual(["midnight"]);
  });
});

describe("search", () => {
  const gigs = [
    gig("titled", { title: "Costco Tasting" }),
    gig("located", { location: "Pike Place Market" }),
    gig("noted", { notes: "Bring the banner and two crates" }),
    gig("client", { clientId: "c2" }),
    gig("other", { title: "Nothing relevant" }),
  ];

  it("matches the title", () => {
    expect(ids(apply(gigs, { search: "costco" }))).toEqual(["titled"]);
  });

  it("matches the location", () => {
    expect(ids(apply(gigs, { search: "pike" }))).toEqual(["located"]);
  });

  it("matches the notes", () => {
    expect(ids(apply(gigs, { search: "crates" }))).toEqual(["noted"]);
  });

  it("matches the client name, which is not on the gig record", () => {
    expect(ids(apply(gigs, { search: "bright" }))).toEqual(["client"]);
  });

  it("ignores case", () => {
    expect(ids(apply(gigs, { search: "COSTCO TASTING" }))).toEqual(["titled"]);
  });

  it("ignores surrounding and repeated whitespace", () => {
    expect(ids(apply(gigs, { search: "  costco   tasting  " }))).toEqual(["titled"]);
  });

  it("returns nothing when nothing matches", () => {
    expect(apply(gigs, { search: "zzzz" })).toEqual([]);
  });

  it("keeps everything for a blank search", () => {
    expect(ids(apply(gigs, { search: "   " }))).toHaveLength(5);
  });
});

describe("client filter", () => {
  const gigs = [
    gig("a1", { clientId: "c1" }),
    gig("a2", { clientId: "c1" }),
    gig("b1", { clientId: "c2" }),
    gig("none"),
  ];

  it("keeps only that client's gigs", () => {
    expect(ids(apply(gigs, { clientId: "c1" }))).toEqual(["a1", "a2"]);
  });

  it("excludes gigs with no client", () => {
    expect(ids(apply(gigs, { clientId: "c2" }))).toEqual(["b1"]);
  });
});

describe("date range", () => {
  const gigs = [
    gig("yesterday", { dateTime: YESTERDAY }),
    gig("today", { dateTime: EARLIER_TODAY }),
    gig("tomorrow", { dateTime: TOMORROW }),
    gig("next-week", { dateTime: NEXT_WEEK }),
    gig("undated"),
  ];

  // Asked for oldest-first so the expectations read as a calendar does.
  it("keeps gigs on or after `from`", () => {
    expect(ids(apply(gigs, { from: START_OF_TODAY, sort: "oldest" }))).toEqual([
      "today",
      "tomorrow",
      "next-week",
    ]);
  });

  it("keeps gigs on or before `to`", () => {
    expect(ids(apply(gigs, { to: END_OF_TODAY, sort: "oldest" }))).toEqual([
      "yesterday",
      "today",
    ]);
  });

  it("includes a gig sitting exactly on a bound", () => {
    const edges = [
      gig("at-from", { dateTime: START_OF_TODAY }),
      gig("at-to", { dateTime: END_OF_TODAY }),
    ];
    expect(
      ids(apply(edges, { from: START_OF_TODAY, to: END_OF_TODAY, sort: "oldest" })),
    ).toEqual(["at-from", "at-to"]);
  });

  it("keeps only what falls between both bounds", () => {
    expect(ids(apply(gigs, { from: START_OF_TODAY, to: END_OF_TODAY }))).toEqual([
      "today",
    ]);
  });

  it("excludes undated gigs once a lower bound is set", () => {
    expect(ids(apply(gigs, { from: START_OF_TODAY }))).not.toContain("undated");
  });

  it("excludes undated gigs once an upper bound is set", () => {
    expect(ids(apply(gigs, { to: END_OF_TODAY }))).not.toContain("undated");
  });

  it("keeps undated gigs when neither bound is set", () => {
    expect(ids(apply(gigs))).toContain("undated");
  });
});

describe("sorting", () => {
  const gigs = [
    gig("undated", { clientId: "c2", amountOfferedCents: 5_000 }),
    gig("old", { dateTime: YESTERDAY, clientId: "c1", amountOfferedCents: 30_000 }),
    gig("new", { dateTime: NEXT_WEEK, amountOfferedCents: 10_000 }),
    gig("mid", { dateTime: TOMORROW, clientId: "c2", amountPaidCents: 20_000 }),
  ];

  it("puts the newest first by default", () => {
    expect(DEFAULT_FILTERS.sort).toBe("newest");
    expect(ids(apply(gigs))).toEqual(["new", "mid", "old", "undated"]);
  });

  it("puts the oldest first", () => {
    expect(ids(apply(gigs, { sort: "oldest" }))).toEqual([
      "old",
      "mid",
      "new",
      "undated",
    ]);
  });

  it("sorts undated last, not first, in both date orders", () => {
    expect(ids(apply(gigs, { sort: "newest" })).at(-1)).toBe("undated");
    expect(ids(apply(gigs, { sort: "oldest" })).at(-1)).toBe("undated");
  });

  it("puts the biggest amount first, using paid over offered", () => {
    expect(ids(apply(gigs, { sort: "amount" }))).toEqual([
      "old",
      "mid",
      "new",
      "undated",
    ]);
  });

  it("ranks an hourly gig on its expected pay, not on its empty offer", () => {
    // An hourly gig stores amountOfferedCents null by design, so the
    // amount sort used to bucket every one of them with the gigs that
    // have no amount at all — at the bottom — while the row beside it
    // displayed a real figure.
    const mixed = [
      gig("fixed300", { amountOfferedCents: 30_000 }),
      gig("hourly400", {
        payType: "hourly",
        hourlyRateCents: 5_000,
        durationMinutes: 480,
        amountOfferedCents: null,
        expectedCents: 40_000,
      }),
    ];
    expect(ids(apply(mixed, { sort: "amount" }))).toEqual([
      "hourly400",
      "fixed300",
    ]);
  });

  it("ranks an unsynced hourly gig on the local derivation", () => {
    // Same gig before it has reached the server. Sorting it last until
    // a pull happens would move a row under the user mid-session.
    const mixed = [
      gig("fixed300", { amountOfferedCents: 30_000 }),
      gig("hourly400", {
        payType: "hourly",
        hourlyRateCents: 5_000,
        durationMinutes: 480,
        amountOfferedCents: null,
        expectedCents: null,
      }),
    ];
    expect(ids(apply(mixed, { sort: "amount" }))).toEqual([
      "hourly400",
      "fixed300",
    ]);
  });

  it("sorts gigs with no amount last", () => {
    const mixed = [gig("none"), gig("small", { amountOfferedCents: 100 })];
    expect(ids(apply(mixed, { sort: "amount" }))).toEqual(["small", "none"]);
  });

  it("sorts by client name A–Z, clientless last", () => {
    expect(ids(apply(gigs, { sort: "client" }))).toEqual([
      "old",
      "undated",
      "mid",
      "new",
    ]);
  });

  it("keeps the input order when the sort key ties", () => {
    const tied = [
      gig("first", { dateTime: TOMORROW }),
      gig("second", { dateTime: TOMORROW }),
    ];
    expect(ids(apply(tied, { sort: "newest" }))).toEqual(["first", "second"]);
  });

  it("does not mutate the array it was given", () => {
    const input = [...gigs];
    apply(input, { sort: "oldest" });
    expect(ids(input)).toEqual(["undated", "old", "new", "mid"]);
  });
});

describe("isFiltered", () => {
  it("is false for the defaults", () => {
    expect(isFiltered(DEFAULT_FILTERS)).toBe(false);
  });

  it("is false for a sort alone — ordering hides nothing", () => {
    expect(isFiltered(filters({ sort: "amount" }))).toBe(false);
  });

  it.each<[string, Partial<GigFilters>]>([
    ["search", { search: "costco" }],
    ["statuses", { statuses: ["cancelled"] }],
    ["client", { clientId: "c1" }],
    ["from", { from: START_OF_TODAY }],
    ["to", { to: END_OF_TODAY }],
    ["hide past", { hidePast: true }],
  ])("is true for %s", (_label, over) => {
    expect(isFiltered(filters(over))).toBe(true);
  });
});

describe("URL round trip", () => {
  it("survives a full set of filters", () => {
    const f = filters({
      search: "costco tasting",
      statuses: ["cancelled", "lead"],
      clientId: "c1",
      from: START_OF_TODAY,
      to: END_OF_TODAY,
      hidePast: true,
      sort: "client",
    });
    expect(parseGigFilters(toSearchParams(f))).toEqual(f);
  });

  it.each<[string, Partial<GigFilters>]>([
    ["a search alone", { search: "pike" }],
    ["one status", { statuses: ["confirmed"] }],
    ["a client alone", { clientId: "c2" }],
    ["a lower bound alone", { from: START_OF_TODAY }],
    ["hide past alone", { hidePast: true }],
    ["a sort alone", { sort: "oldest" }],
  ])("survives %s", (_label, over) => {
    const f = filters(over);
    expect(parseGigFilters(toSearchParams(f))).toEqual(f);
  });

  it("writes an empty query string for the defaults", () => {
    expect(toSearchParams(DEFAULT_FILTERS).toString()).toBe("");
  });

  it("writes each status as its own repeated key", () => {
    const params = toSearchParams(filters({ statuses: ["lead", "cancelled"] }));
    expect(params.getAll("status")).toEqual(["lead", "cancelled"]);
  });

  it("reads back an empty query string as the defaults", () => {
    expect(parseGigFilters(new URLSearchParams())).toEqual(DEFAULT_FILTERS);
  });

  it("drops statuses it does not recognise", () => {
    const params = new URLSearchParams("status=lead&status=nonsense");
    expect(parseGigFilters(params).statuses).toEqual<GigStatus[]>(["lead"]);
  });

  it("falls back to no statuses when none are recognised", () => {
    expect(parseGigFilters(new URLSearchParams("status=nonsense")).statuses).toEqual([]);
  });

  it("falls back to no bounds for unparseable dates", () => {
    const parsed = parseGigFilters(new URLSearchParams("from=soon&to="));
    expect(parsed.from).toBeNull();
    expect(parsed.to).toBeNull();
  });

  it("falls back to the default sort for an unknown one", () => {
    expect(parseGigFilters(new URLSearchParams("sort=sideways")).sort).toBe("newest");
  });

  it("treats anything but 1 as hide-past off", () => {
    expect(parseGigFilters(new URLSearchParams("hidePast=0")).hidePast).toBe(false);
    expect(parseGigFilters(new URLSearchParams("hidePast=1")).hidePast).toBe(true);
  });

  it("reads an empty client as no client filter", () => {
    expect(parseGigFilters(new URLSearchParams("client=")).clientId).toBeNull();
  });
});

describe("date input bounds", () => {
  it("reads a date as the whole of that local day", () => {
    expect(dateInputToMs("2026-08-10", "start")).toBe(START_OF_TODAY);
    expect(dateInputToMs("2026-08-10", "end")).toBe(END_OF_TODAY);
  });

  it("reads an empty or malformed value as no bound", () => {
    expect(dateInputToMs("", "start")).toBeNull();
    expect(dateInputToMs("10/08/2026", "start")).toBeNull();
  });

  it("renders a bound back into the input's format", () => {
    expect(msToDateInput(START_OF_TODAY)).toBe("2026-08-10");
    expect(msToDateInput(END_OF_TODAY)).toBe("2026-08-10");
    expect(msToDateInput(null)).toBe("");
  });
});

/**
 * Persisting the view (settings round-trip).
 *
 * Two rules carry the weight here:
 *
 *   - The search text is never persisted. A query that outlives the
 *     session shows an empty list on open with nothing on screen
 *     explaining why, and it is the one filter quicker to retype than
 *     to diagnose.
 *   - A saved range whose END has passed is dropped on read. Saving
 *     "1-7 Aug" and opening the app in September should not mean an
 *     empty list every time. An OPEN-ended range (from, no to) never
 *     expires: "everything from March onwards" stays true.
 */
describe("settings round-trip", () => {
  const SAVED: SettingsView = {
    gigListStatuses: ["lead", "confirmed"],
    gigListSort: "amount",
    gigListHidePast: true,
    gigListClientId: "client-7",
    gigListFrom: null,
    gigListTo: null,
  };

  it("restores everything it stores", () => {
    const restored = filtersFromSettings(SAVED, NOW);
    expect(restored.statuses).toEqual(["lead", "confirmed"]);
    expect(restored.sort).toBe("amount");
    expect(restored.hidePast).toBe(true);
    expect(restored.clientId).toBe("client-7");
  });

  it("never restores a search — it is not stored in the first place", () => {
    const patch = settingsPatchFromFilters({
      ...DEFAULT_FILTERS,
      search: "wedding",
    });
    expect(Object.values(patch)).not.toContain("wedding");
    expect(filtersFromSettings(SAVED, NOW).search).toBe("");
  });

  it("survives a full round-trip unchanged", () => {
    const filters: GigFilters = {
      search: "",
      statuses: ["cancelled"],
      clientId: "client-3",
      from: START_OF_TODAY,
      to: END_OF_TODAY,
      hidePast: false,
      sort: "client",
    };
    expect(filtersFromSettings(settingsPatchFromFilters(filters), NOW)).toEqual(
      filters,
    );
  });

  it("keeps a range that has not finished yet", () => {
    const restored = filtersFromSettings(
      { ...SAVED, gigListFrom: YESTERDAY, gigListTo: END_OF_TODAY },
      NOW,
    );
    expect(restored.from).toBe(YESTERDAY);
    expect(restored.to).toBe(END_OF_TODAY);
  });

  it("drops a range that has fully passed, and only the range", () => {
    const lastWeekStart = new Date(2026, 7, 1).getTime();
    const lastWeekEnd = new Date(2026, 7, 7, 23, 59, 59, 999).getTime();
    const restored = filtersFromSettings(
      { ...SAVED, gigListFrom: lastWeekStart, gigListTo: lastWeekEnd },
      NOW,
    );
    expect(restored.from).toBeNull();
    expect(restored.to).toBeNull();
    // The rest of the saved view is untouched — expiry is about the
    // dates, not a reset.
    expect(restored.statuses).toEqual(["lead", "confirmed"]);
    expect(restored.hidePast).toBe(true);
    expect(restored.clientId).toBe("client-7");
  });

  it("keeps an open-ended range however old its start", () => {
    const march = new Date(2026, 2, 1).getTime();
    const restored = filtersFromSettings(
      { ...SAVED, gigListFrom: march, gigListTo: null },
      NOW,
    );
    expect(restored.from).toBe(march);
    expect(restored.to).toBeNull();
  });

  it("treats a range ending today as live, not passed", () => {
    // The boundary case: END_OF_TODAY is 23:59:59.999 and NOW is 14:30.
    // Expiring this would delete a range while the user is inside it.
    const restored = filtersFromSettings(
      { ...SAVED, gigListFrom: START_OF_TODAY, gigListTo: END_OF_TODAY },
      NOW,
    );
    expect(restored.to).toBe(END_OF_TODAY);
  });

  it("reads a cleared view back as the defaults", () => {
    const patch = settingsPatchFromFilters(DEFAULT_FILTERS);
    expect(filtersFromSettings(patch, NOW)).toEqual(DEFAULT_FILTERS);
  });
});

describe("hasFilterParams", () => {
  it("is false for a bare list URL", () => {
    expect(hasFilterParams(new URLSearchParams(""))).toBe(false);
  });

  it("is true for any filter key, including ones left empty", () => {
    for (const query of [
      "q=wedding",
      "status=lead",
      "client=c1",
      "from=1",
      "to=2",
      "hidePast=1",
      "sort=amount",
      // An empty value still counts: the link said "no client filter",
      // and the saved view must not overrule that.
      "client=",
    ]) {
      expect(hasFilterParams(new URLSearchParams(query))).toBe(true);
    }
  });

  it("ignores keys that are not ours", () => {
    expect(hasFilterParams(new URLSearchParams("utm_source=email&ref=x"))).toBe(
      false,
    );
  });

  it("covers every key toSearchParams can emit", () => {
    // The guard on the two lists drifting apart. If a new filter gains a
    // param, this fails until hasFilterParams learns about it — without
    // which a saved view would silently override a shared link.
    const everything = toSearchParams({
      search: "x",
      statuses: ["lead"],
      clientId: "c1",
      from: 1,
      to: 2,
      hidePast: true,
      sort: "amount",
    });
    for (const key of everything.keys()) {
      expect(hasFilterParams(new URLSearchParams([[key, "v"]]))).toBe(true);
    }
  });
});
