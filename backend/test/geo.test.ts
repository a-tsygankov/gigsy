/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeAll, vi } from "vitest";
import { SELF, env } from "cloudflare:test";
import { Hono } from "hono";
import { applyMigrations, seedUser } from "./helpers/db.ts";
import { issueAccessToken } from "../src/auth/tokens.ts";
import { makeGeoRouter } from "../src/routes/geo.ts";
import {
  NominatimProvider,
  StubGeocodeProvider,
  geocodeProviderFromEnv,
} from "../src/geo/providers.ts";
import type { Bindings } from "../src/env.ts";

const U1 = "geo-user-1";

async function call(app: Hono, path: string): Promise<Response> {
  const token = await issueAccessToken({
    userId: U1,
    secret: env.AUTH_SECRET,
    ttlSeconds: 900,
  });
  return app.request(
    path,
    { headers: { Authorization: `Bearer ${token}` } },
    env as unknown as Bindings,
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeAll(async () => {
  await applyMigrations(env.DB);
  await seedUser(env.DB, U1);
});

describe("GET /api/geo/reverse", () => {
  it("401s without a token — it spends a third-party quota", async () => {
    const res = await SELF.fetch("https://localhost/api/geo/reverse?lat=1&lon=2");
    expect(res.status).toBe(401);
  });

  it("returns a label for valid coordinates", async () => {
    const app = new Hono().route(
      "/api/geo",
      makeGeoRouter({ provider: { reverse: async () => "Costco, 5th Ave, Seattle" } }),
    );
    const res = await call(app, "/api/geo/reverse?lat=47.6&lon=-122.3");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      label: "Costco, 5th Ave, Seattle",
      fallback: false,
    });
  });

  // A failed lookup is a normal outcome, not a 5xx: the client writes
  // the raw coordinates into the field instead.
  it("reports a failed lookup as a fallback, not an error", async () => {
    const app = new Hono().route(
      "/api/geo",
      makeGeoRouter({ provider: { reverse: async () => null } }),
    );
    const res = await call(app, "/api/geo/reverse?lat=47.6&lon=-122.3");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ label: null, fallback: true });
  });

  it("rejects out-of-range coordinates", async () => {
    const app = new Hono().route("/api/geo", makeGeoRouter());
    for (const q of ["lat=91&lon=0", "lat=0&lon=181", "lat=abc&lon=0"]) {
      expect((await call(app, `/api/geo/reverse?${q}`)).status).toBe(400);
    }
  });
});

describe("NominatimProvider", () => {
  it("builds a label from venue, street and town", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        name: "Costco Wholesale",
        address: { house_number: "4401", road: "4th Ave S", city: "Seattle" },
      }),
    ) as unknown as typeof fetch;

    const label = await new NominatimProvider(fetchFn).reverse(47.6, -122.3);
    expect(label).toBe("Costco Wholesale, 4401 4th Ave S, Seattle");
  });

  it("identifies itself, as the provider's usage policy requires", async () => {
    const seen: RequestInit[] = [];
    const fetchFn = (async (_url: string, init: RequestInit) => {
      seen.push(init);
      return jsonResponse({ name: "Somewhere" });
    }) as unknown as typeof fetch;

    await new NominatimProvider(fetchFn).reverse(1, 2);
    const ua = (seen[0]?.headers as Record<string, string>)["user-agent"];
    expect(ua).toMatch(/Gigsy/);
  });

  it("falls back to the provider's own rendering, trimmed", async () => {
    const fetchFn = (async () =>
      jsonResponse({
        display_name: "12, Long Road, Sometown, County, Region, 90210, Country",
      })) as unknown as typeof fetch;

    const label = await new NominatimProvider(fetchFn).reverse(1, 2);
    expect(label).toBe("12, Long Road, Sometown");
  });

  it("yields null on a non-OK response or a network error", async () => {
    const bad = (async () => jsonResponse({}, 503)) as unknown as typeof fetch;
    expect(await new NominatimProvider(bad).reverse(1, 2)).toBeNull();

    const boom = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await new NominatimProvider(boom).reverse(1, 2)).toBeNull();
  });
});

describe("geocodeProviderFromEnv", () => {
  const base = { ENVIRONMENT: "development" } as Partial<Bindings> as Bindings;

  it("defaults to the real provider", () => {
    expect(geocodeProviderFromEnv(base)).toBeInstanceOf(NominatimProvider);
  });

  it("serves the stub only outside production", () => {
    expect(
      geocodeProviderFromEnv({ ...base, GEOCODE_PROVIDER: "stub" }),
    ).toBeInstanceOf(StubGeocodeProvider);
    expect(
      geocodeProviderFromEnv({
        ...base,
        GEOCODE_PROVIDER: "stub",
        ENVIRONMENT: "production",
      }),
    ).toBeInstanceOf(NominatimProvider);
  });

  // "off" is the privacy switch: no position leaves the worker.
  it("can be disabled entirely", async () => {
    const provider = geocodeProviderFromEnv({ ...base, GEOCODE_PROVIDER: "off" });
    expect(await provider.reverse(47.6, -122.3)).toBeNull();
  });
});
