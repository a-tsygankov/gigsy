/**
 * Reverse geocoding for the gig form's "use current location"
 * (docs/superpowers/plans/2026-08-10-phase9-features.md). The device
 * supplies coordinates; this turns them into words.
 *
 * Authenticated, because it spends a third-party quota on the user's
 * behalf. Nothing is written to D1 — the coordinates live only for the
 * duration of the request.
 */
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { Bindings } from "../env.ts";
import { requireAuth, type AuthVars } from "../middleware/auth.ts";
import { geocodeProviderFromEnv, type GeocodeProvider } from "../geo/providers.ts";

const ReverseQuery = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lon: z.coerce.number().min(-180).max(180),
});

export interface GeoDeps {
  provider?: GeocodeProvider;
}

export function makeGeoRouter(deps: GeoDeps = {}) {
  return new Hono<{ Bindings: Bindings; Variables: AuthVars }>()
    .use("*", requireAuth)
    .get("/reverse", zValidator("query", ReverseQuery), async (c) => {
      const { lat, lon } = c.req.valid("query");
      const provider = deps.provider ?? geocodeProviderFromEnv(c.env);
      const label = await provider.reverse(lat, lon);
      // A failed lookup is not an error: a coordinate in the Location
      // field still beats an empty one when you're in a car park.
      return c.json({ label, fallback: label === null });
    });
}

export const geoRouter = makeGeoRouter();
