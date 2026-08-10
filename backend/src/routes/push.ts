/**
 * Push subscription management (Phase 10).
 *
 * The browser owns the subscription: it asks its push service for one,
 * then hands us the endpoint and key material to store. We never mint
 * subscriptions, only record and forget them.
 *
 * `/config` is what the client needs *before* subscribing — the VAPID
 * public key — and doubles as the feature switch: no key configured
 * means push is off, and the UI says so rather than failing at the
 * permission prompt.
 */
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { Bindings } from "../env.ts";
import { requireAuth, type AuthVars } from "../middleware/auth.ts";
import { PushSubscriptionsRepo } from "../repos/push-subscriptions.ts";

// Endpoint length is capped because it's a primary key and comes from
// a third party; the key material has fixed sizes once base64url'd.
const Subscription = z.object({
  endpoint: z.string().url().max(1000),
  p256dh: z.string().min(1).max(200),
  auth: z.string().min(1).max(100),
});

const Unsubscribe = z.object({ endpoint: z.string().url().max(1000) });

export const pushRouter = new Hono<{ Bindings: Bindings; Variables: AuthVars }>()
  .use("*", requireAuth)
  .get("/config", (c) => {
    const publicKey = c.env.VAPID_PUBLIC_KEY ?? "";
    return c.json({
      // Both halves must be present: a public key with no private key
      // would let the browser subscribe to notifications we can never
      // send, which looks like a bug to the user.
      enabled: publicKey !== "" && (c.env.VAPID_PRIVATE_KEY ?? "") !== "",
      publicKey,
    });
  })
  .put("/subscription", zValidator("json", Subscription), async (c) => {
    await PushSubscriptionsRepo.for(c.env.DB).save(
      c.get("userId"),
      c.req.valid("json"),
      Date.now(),
    );
    return c.json({ subscribed: true });
  })
  .delete("/subscription", zValidator("json", Unsubscribe), async (c) => {
    // Idempotent: unsubscribing something already gone is a success,
    // because the caller's intent is satisfied either way.
    await PushSubscriptionsRepo.for(c.env.DB).remove(
      c.get("userId"),
      c.req.valid("json").endpoint,
    );
    return c.json({ subscribed: false });
  });
