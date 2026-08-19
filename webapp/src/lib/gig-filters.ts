/**
 * Narrowing and ordering the gig list.
 *
 * Everything here is pure and takes `now` as an argument. The list is
 * already local-first, so filtering is a pass over the array we have
 * rather than a query — and keeping the rules out of the component is
 * what lets the awkward cases (undated gigs, local midnight) be tested
 * without a browser.
 *
 * Two rules that look inconsistent and are not:
 *   - "Hide past" keeps undated gigs. A lead with no date is the
 *     liveliest thing on the list; dropping it as history is the one
 *     outcome nobody wants.
 *   - A date range drops them. "What's on that week" cannot honestly be
 *     answered with something that has no date.
 */
import { GIG_STATUSES, type Gig, type GigStatus } from "./types.ts";
import { storedOrDerivedExpectedCents } from "./gig-pay.ts";

export const GIG_SORTS = ["newest", "oldest", "amount", "client"] as const;
export type GigSort = (typeof GIG_SORTS)[number];

export interface GigFilters {
  search: string;
  statuses: readonly GigStatus[];
  clientId: string | null;
  from: number | null;
  to: number | null;
  hidePast: boolean;
  sort: GigSort;
}

export const DEFAULT_FILTERS: GigFilters = {
  search: "",
  statuses: [],
  clientId: null,
  from: null,
  to: null,
  hidePast: false,
  sort: "newest",
};

/**
 * Whether the list on screen is smaller than the list in the database.
 * Sort is deliberately not part of it: reordering hides nothing, so it
 * has no business lighting up "Showing 3 of 40" or a Clear button.
 */
export function isFiltered(filters: GigFilters): boolean {
  return (
    normalize(filters.search) !== "" ||
    filters.statuses.length > 0 ||
    filters.clientId !== null ||
    filters.from !== null ||
    filters.to !== null ||
    filters.hidePast
  );
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** What the amount sort ranks on — the same number the row displays.
 *  Which is why it reads the expected pay and not `amountOfferedCents`:
 *  on an hourly gig that column is only an optional override, so the
 *  sort put every hourly gig at the bottom with the amount-less ones
 *  while the row showed a figure. */
function amountOf(gig: Gig): number | null {
  return gig.amountPaidCents ?? storedOrDerivedExpectedCents(gig);
}

/** Missing values sort last in every mode, whichever way the rest goes. */
function compareNullable<T>(
  a: T | null,
  b: T | null,
  compare: (a: T, b: T) => number,
): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return compare(a, b);
}

export function applyGigFilters(
  gigs: readonly Gig[],
  filters: GigFilters,
  clientNames: ReadonlyMap<string, string>,
  now: number,
): Gig[] {
  const needle = normalize(filters.search);
  const hasBound = filters.from !== null || filters.to !== null;
  const today = startOfDay(now);

  const nameOf = (gig: Gig): string | null =>
    gig.clientId === null ? null : (clientNames.get(gig.clientId) ?? null);

  const kept = gigs.filter((gig) => {
    if (filters.statuses.length > 0 && !filters.statuses.includes(gig.status)) {
      return false;
    }
    if (filters.clientId !== null && gig.clientId !== filters.clientId) return false;

    if (hasBound) {
      if (gig.dateTime === null) return false;
      if (filters.from !== null && gig.dateTime < filters.from) return false;
      if (filters.to !== null && gig.dateTime > filters.to) return false;
    }

    // Anything at all today stays: a gig that started this morning is
    // still the thing you are in the middle of.
    if (filters.hidePast && gig.dateTime !== null && gig.dateTime < today) {
      return false;
    }

    if (needle !== "") {
      const haystack = [gig.title, gig.location, gig.notes, nameOf(gig)]
        .filter((part): part is string => part !== null)
        .map(normalize)
        .join(" ");
      if (!haystack.includes(needle)) return false;
    }

    return true;
  });

  // filter() already copied, and sort() is stable, so ties keep the
  // order the caller supplied.
  switch (filters.sort) {
    case "oldest":
      return kept.sort((a, b) => compareNullable(a.dateTime, b.dateTime, (x, y) => x - y));
    case "amount":
      return kept.sort((a, b) =>
        compareNullable(amountOf(a), amountOf(b), (x, y) => y - x),
      );
    case "client":
      return kept.sort((a, b) =>
        compareNullable(nameOf(a), nameOf(b), (x, y) => x.localeCompare(y)),
      );
    default:
      return kept.sort((a, b) => compareNullable(a.dateTime, b.dateTime, (x, y) => y - x));
  }
}

/**
 * Date-only input value → the whole of that local day in epoch ms, so a
 * range means the days a user would read off a calendar.
 */
export function dateInputToMs(value: string, edge: "start" | "end"): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (m === null) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  return edge === "start"
    ? new Date(y, mo, d).getTime()
    : new Date(y, mo, d, 23, 59, 59, 999).getTime();
}

export function msToDateInput(ms: number | null): string {
  if (ms === null) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The saved half of a view — the settings fields this module owns.
 *
 * Structurally a subset of `Settings`, declared here rather than
 * imported so that the pure filter logic does not depend on the whole
 * settings surface. `settings-schema.ts` is the mirror that has to
 * match; a drift shows up as a type error at the call site.
 */
export interface SettingsView {
  gigListStatuses: GigStatus[];
  gigListSort: GigSort;
  gigListHidePast: boolean;
  gigListClientId: string | null;
  gigListFrom: number | null;
  gigListTo: number | null;
}

/**
 * A saved range is spent once its end is behind us.
 *
 * Without this, saving "1-7 Aug" and coming back in September means an
 * empty list on every open, with nothing on screen saying why — which
 * reads as lost data rather than as a filter. Dropping BOTH bounds
 * matters: keeping `from` alone would silently widen the range into
 * something the user never chose.
 *
 * An open-ended range (a `from` with no `to`) never expires — "March
 * onwards" is still true in December — and a range ending today is
 * live, because the user is inside it.
 */
function expirePastRange(
  from: number | null,
  to: number | null,
  now: number,
): { from: number | null; to: number | null } {
  if (to !== null && to < startOfDay(now)) return { from: null, to: null };
  return { from, to };
}

/** Seed a view from what was saved. `now` is a parameter for the same
 *  reason it is everywhere else here: local midnight is the boundary. */
export function filtersFromSettings(saved: SettingsView, now: number): GigFilters {
  const { from, to } = expirePastRange(saved.gigListFrom, saved.gigListTo, now);
  return {
    // Never persisted, so never restored — always the empty box.
    search: DEFAULT_FILTERS.search,
    statuses: saved.gigListStatuses,
    clientId: saved.gigListClientId,
    from,
    to,
    hidePast: saved.gigListHidePast,
    sort: saved.gigListSort,
  };
}

/** The inverse, minus the search. Returns every field rather than only
 *  the changed ones, so clearing a filter persists as cleared instead of
 *  leaving the old value behind. */
export function settingsPatchFromFilters(filters: GigFilters): SettingsView {
  return {
    gigListStatuses: [...filters.statuses],
    gigListSort: filters.sort,
    gigListHidePast: filters.hidePast,
    gigListClientId: filters.clientId,
    gigListFrom: filters.from,
    gigListTo: filters.to,
  };
}

function isGigStatus(value: string): value is GigStatus {
  return (GIG_STATUSES as readonly string[]).includes(value);
}

function isGigSort(value: string | null): value is GigSort {
  return value !== null && (GIG_SORTS as readonly string[]).includes(value);
}

function parseMs(value: string | null): number | null {
  if (value === null || value === "") return null;
  const ms = Number(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Every key `toSearchParams` can emit. Kept next to it deliberately —
 *  the two drift apart silently otherwise, and the cost is a saved view
 *  quietly overriding a shared link. */
const FILTER_PARAM_KEYS = [
  "q",
  "status",
  "client",
  "from",
  "to",
  "hidePast",
  "sort",
] as const;

/**
 * Whether the URL is already expressing a view.
 *
 * The question behind it is "did someone ask for this list, or just
 * open it" — a link with `?status=lead` must win over whatever was
 * saved, or shared links stop meaning what they say.
 */
export function hasFilterParams(params: URLSearchParams): boolean {
  return FILTER_PARAM_KEYS.some((key) => params.has(key));
}

export function parseGigFilters(params: URLSearchParams): GigFilters {
  const client = params.get("client");
  const sort = params.get("sort");
  return {
    search: params.get("q") ?? DEFAULT_FILTERS.search,
    statuses: params.getAll("status").filter(isGigStatus),
    clientId: client === null || client === "" ? null : client,
    from: parseMs(params.get("from")),
    to: parseMs(params.get("to")),
    hidePast: params.get("hidePast") === "1",
    sort: isGigSort(sort) ? sort : DEFAULT_FILTERS.sort,
  };
}

/**
 * Every default is written as absence, so an unfiltered list has a clean
 * URL and the back button has nothing pointless to remember. Bounds go
 * out as epoch ms rather than dates: it is the value we hold, and it
 * round-trips without a timezone getting a vote.
 */
export function toSearchParams(filters: GigFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.search !== "") params.set("q", filters.search);
  for (const status of filters.statuses) params.append("status", status);
  if (filters.clientId !== null) params.set("client", filters.clientId);
  if (filters.from !== null) params.set("from", String(filters.from));
  if (filters.to !== null) params.set("to", String(filters.to));
  if (filters.hidePast) params.set("hidePast", "1");
  if (filters.sort !== DEFAULT_FILTERS.sort) params.set("sort", filters.sort);
  return params;
}
