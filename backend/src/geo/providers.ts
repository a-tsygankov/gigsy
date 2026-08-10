/**
 * Reverse geocoding: coordinates → a place a human recognises
 * (docs/superpowers/plans/2026-08-10-phase9-features.md).
 *
 * This runs in the worker rather than the browser so no provider key
 * reaches the client and the provider stays swappable by config — the
 * same shape as the extraction providers. Coordinates are never
 * persisted: they arrive as query parameters and leave as a label.
 *
 * Privacy note worth keeping visible: resolving a label sends the
 * user's precise position to a third party. It happens only when the
 * user taps "use current location".
 */
import type { Bindings } from "../env.ts";

export interface GeocodeProvider {
  /** A human-readable label, or null when the lookup fails. */
  reverse(lat: number, lon: number): Promise<string | null>;
}

/** Keyless OpenStreetMap endpoint. Its usage policy requires an
 * identifying User-Agent and modest request rates — both satisfied by
 * one user tapping a button. */
export class NominatimProvider implements GeocodeProvider {
  constructor(private readonly fetchFn: typeof fetch = fetch.bind(globalThis)) {}

  async reverse(lat: number, lon: number): Promise<string | null> {
    const url =
      "https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18" +
      `&lat=${lat}&lon=${lon}`;
    try {
      const res = await this.fetchFn(url, {
        headers: {
          "user-agent": "Gigsy/1.0 (personal gig tracker; contact via github.com/a-tsygankov/gigsy)",
          accept: "application/json",
        },
      });
      if (!res.ok) return null;
      const body = (await res.json()) as {
        name?: string;
        display_name?: string;
        address?: Record<string, string>;
      };
      return labelFrom(body);
    } catch {
      return null;
    }
  }
}

/**
 * Prefer the venue name plus enough address to disambiguate it —
 * "Costco Wholesale, 5th Avenue, Seattle" beats both a bare shop name
 * and the provider's full comma-salad, which runs to postcode and
 * country.
 */
function labelFrom(body: {
  name?: string;
  display_name?: string;
  address?: Record<string, string>;
}): string | null {
  const a = body.address ?? {};
  const street = [a["house_number"], a["road"]].filter(Boolean).join(" ");
  const town = a["city"] ?? a["town"] ?? a["village"] ?? a["suburb"];
  const parts = [body.name, street, town].filter(
    (p): p is string => typeof p === "string" && p !== "",
  );
  if (parts.length > 0) return [...new Set(parts)].join(", ");
  // Fall back to the provider's own rendering, trimmed to the first
  // three components so it stays readable in a form field.
  const display = body.display_name;
  return display === undefined ? null : display.split(",").slice(0, 3).join(",").trim();
}

/** Deterministic provider for dev/e2e — no third-party call. */
export class StubGeocodeProvider implements GeocodeProvider {
  async reverse(lat: number, lon: number): Promise<string | null> {
    return `Stub Venue, ${lat.toFixed(3)}, ${lon.toFixed(3)}`;
  }
}

export function geocodeProviderFromEnv(env: Bindings): GeocodeProvider {
  if (env.GEOCODE_PROVIDER === "stub" && env.ENVIRONMENT !== "production") {
    return new StubGeocodeProvider();
  }
  if (env.GEOCODE_PROVIDER === "off") {
    // Explicitly disabled: every lookup fails, so the client falls back
    // to plain coordinates and no position ever leaves the worker.
    return { reverse: async () => null };
  }
  return new NominatimProvider();
}
