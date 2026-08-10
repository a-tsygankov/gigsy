/**
 * Managing your own availability link (Phase 12, Task 5).
 *
 * The private counterpart to /api/a/:token. That route has no login
 * because a stranger reads it; this one is behind auth like everything
 * else, because it decides who gets to read it at all.
 *
 * The shape is forced by a decision made in Task 2: only the SHA-256
 * hash of a token is stored, so the raw value exists exactly once — in
 * the response to POST. There is deliberately no endpoint that shows it
 * again, because there is nothing to show it from. "Regenerate" takes
 * the place of "remind me", and the settings screen has to say so.
 */
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { Bindings } from "../env.ts";
import { requireAuth, type AuthVars } from "../middleware/auth.ts";
import { AvailabilityTokenStore } from "../repos/availability-tokens.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Expiry is optional, because whether a link should die on its own is
 * the user's call — but when they do ask for one it has to be a number
 * of days that means something. Two years is the ceiling: past that,
 * "never" is the honest choice rather than a date nobody will revisit.
 */
const Mint = z
  .object({
    expiresInDays: z.number().int().min(1).max(730).nullable().optional(),
  })
  .strict();

export function makeAvailabilityLinkRouter() {
  return new Hono<{ Bindings: Bindings; Variables: AuthVars }>()
    .use("*", requireAuth)
    /** Whether a link is live, and when it was made. Never the token. */
    .get("/", async (c) => {
      const active = await AvailabilityTokenStore.for(c.env.DB).active(
        c.get("userId"),
        Date.now(),
      );
      return c.json({ active });
    })
    /**
     * Mint a link, invalidating whatever came before.
     *
     * One active link per user is the simplest model that supports
     * "stop showing this to them", and it means this endpoint is both
     * "create" and "regenerate" — there is no separate rotate.
     */
    .post("/", zValidator("json", Mint), async (c) => {
      const now = Date.now();
      const expiresInDays = c.req.valid("json").expiresInDays ?? null;
      const token = await AvailabilityTokenStore.for(c.env.DB).issue(
        c.get("userId"),
        now,
        expiresInDays === null ? null : expiresInDays * DAY_MS,
      );
      // The path rather than a full URL: the worker does not know which
      // origin the app is served from, and guessing would produce a
      // link that looks authoritative and does not work.
      return c.json({
        token,
        path: `/a/${token}`,
        createdAt: now,
        expiresAt: expiresInDays === null ? null : now + expiresInDays * DAY_MS,
      });
    })
    /** Stop the link. Idempotent — two taps on revoke is not an error. */
    .delete("/", async (c) => {
      await AvailabilityTokenStore.for(c.env.DB).revokeAll(
        c.get("userId"),
        Date.now(),
      );
      return c.json({ active: null });
    });
}
