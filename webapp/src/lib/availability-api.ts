/**
 * Fetching a public availability page (Phase 12, Task 4).
 *
 * Deliberately not a method on ApiClient. That client exists to attach
 * a bearer token and to refresh it on a 401 — machinery this endpoint
 * must never touch, because the whole point is that the reader is a
 * stranger with no account. Keeping it separate means there is no path
 * by which a visitor's page load could reach the signed-in user's
 * session at all.
 *
 * Failure is a value, not an exception. There are exactly three things
 * the page can say, and each needs different words: here is the
 * availability, this link is not valid, or we could not reach the
 * server. A thrown error would collapse the last two.
 */

export interface Slot {
  start: number;
  end: number;
}

/** Mirrors PublicAvailability in the worker. Nothing else is served —
 *  no client, no location, no amount, no id. */
export interface PublicAvailability {
  displayName: string | null;
  timeZone: string;
  generatedAt: number;
  horizonEndsAt: number;
  slots: Slot[];
  /** Whether the owner's own calendar was read. The page has to say. */
  basedOn: "gigs" | "gigs-and-calendar";
}

export type AvailabilityResult =
  | { status: "ok"; availability: PublicAvailability }
  /** Unknown, revoked or expired — the server does not distinguish, and
   *  neither should the page. */
  | { status: "not-found" }
  | { status: "unavailable" };

export async function fetchPublicAvailability(
  token: string,
  fetchFn: typeof fetch = fetch.bind(globalThis),
): Promise<AvailabilityResult> {
  try {
    const res = await fetchFn(`/api/a/${encodeURIComponent(token)}`, {
      headers: { accept: "application/json" },
      // A schedule is not something to leave in a shared cache; the
      // server says so too, and both are cheap.
      cache: "no-store",
    });

    if (res.status === 404) return { status: "not-found" };
    if (!res.ok) return { status: "unavailable" };

    const body = (await res.json()) as PublicAvailability;
    // A body that is not the shape we expect is a server we cannot
    // trust to render, not a link that is broken.
    if (!Array.isArray(body.slots) || typeof body.timeZone !== "string") {
      return { status: "unavailable" };
    }
    return { status: "ok", availability: body };
  } catch {
    return { status: "unavailable" };
  }
}
