import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { Bindings } from "../env.ts";
import { requireAuth, type AuthVars } from "../middleware/auth.ts";
import { AllocationInput, entityId } from "../domain/schemas.ts";
import { AllocationsRepo } from "../repos/allocations.ts";
import { PaymentsRepo } from "../repos/payments.ts";
import { GigsRepo } from "../repos/gigs.ts";
import { recomputePaidTotals } from "../services/paid-totals.ts";

export const allocationsRouter = new Hono<{ Bindings: Bindings; Variables: AuthVars }>()
  .use("*", requireAuth)
  .get("/", async (c) => {
    const userId = c.get("userId");
    const paymentId = c.req.query("paymentId");
    const gigId = c.req.query("gigId");
    const repo = AllocationsRepo.for(c.env.DB);
    const items =
      paymentId != null
        ? await repo.listByPayment(userId, paymentId)
        : gigId != null
          ? await repo.listByGig(userId, gigId)
          : await repo.list(userId);
    return c.json({ items });
  })
  .get("/:id", async (c) => {
    const repo = AllocationsRepo.for(c.env.DB);
    const record = await repo.get(c.get("userId"), c.req.param("id"));
    return record === null ? c.json({ error: "not found" }, 404) : c.json(record);
  })
  .put("/:id", zValidator("json", AllocationInput), async (c) => {
    const id = c.req.param("id");
    if (!entityId.safeParse(id).success) {
      return c.json({ error: "id must be a UUID" }, 400);
    }
    const userId = c.get("userId");
    const input = c.req.valid("json");
    const now = Date.now();

    // Ownership of the payment and the gig this allocation names. This
    // is the route's own check, deliberately separate from the
    // defence-in-depth check AllocationsRepo.upsert performs internally
    // — see that file's docstring. A bare repo "forbidden" cannot
    // distinguish "not your payment" from "not your gig" from "not your
    // allocation row", and this plan needs a 400 naming which, not a
    // generic 404.
    const payment = await PaymentsRepo.for(c.env.DB).get(userId, input.paymentId);
    if (payment === null) {
      return c.json({ error: "paymentId does not reference your payment" }, 400);
    }
    const gig = await GigsRepo.for(c.env.DB).get(userId, input.gigId);
    if (gig === null) {
      return c.json({ error: "gigId does not reference your gig" }, 400);
    }

    // The client rule: once a payment names a client, every gig it
    // allocates to must belong to that client. A null-client payment
    // allocates freely — the constraint only bites once a client does.
    if (payment.clientId != null && gig.clientId !== payment.clientId) {
      return c.json({ error: "gigId does not reference the payment's client" }, 400);
    }

    const allocationsRepo = AllocationsRepo.for(c.env.DB);

    // Partial allocation is allowed (a deposit can land before anyone
    // knows which gigs it covers); over-allocation is not. Sum every
    // *other* allocation against this payment — excluding this id, so
    // an update to an existing allocation compares against its own
    // replacement, not its own past value twice.
    const existingForPayment = await allocationsRepo.listByPayment(userId, input.paymentId);
    const priorSelf = existingForPayment.find((a) => a.id === id);
    const othersTotal = existingForPayment
      .filter((a) => a.id !== id)
      .reduce((sum, a) => sum + a.amountCents, 0);
    if (othersTotal + input.amountCents > payment.amountCents) {
      return c.json({ error: "allocations exceed the payment" }, 400);
    }

    const result = await allocationsRepo.upsert(
      userId,
      id,
      { paymentId: input.paymentId, gigId: input.gigId, amountCents: input.amountCents },
      { now },
    );
    // Ownership of payment/gig was already checked above, so a
    // "forbidden" here can only mean the allocation row itself belongs
    // to someone else — the ordinary LWW case every other repo reports,
    // mapped to the same generic 404 (routes/gigs.ts, services/sync.ts).
    if (result === "forbidden") return c.json({ error: "not found" }, 404);

    // Recompute the gig this allocation now points at, and — if it
    // moved — the gig it used to point at too, so neither total is
    // left stale.
    const affectedGigIds = new Set([input.gigId]);
    if (priorSelf !== undefined && priorSelf.gigId !== input.gigId) {
      affectedGigIds.add(priorSelf.gigId);
    }
    await recomputePaidTotals(c.env.DB, userId, [...affectedGigIds], now);

    return c.json(result.record, result.created ? 201 : 200);
  })
  .delete("/:id", async (c) => {
    const userId = c.get("userId");
    const id = c.req.param("id");
    const allocationsRepo = AllocationsRepo.for(c.env.DB);
    const existing = await allocationsRepo.get(userId, id);
    const removed = await allocationsRepo.remove(userId, id);
    if (!removed) return c.json({ error: "not found" }, 404);
    if (existing !== null) {
      await recomputePaidTotals(c.env.DB, userId, [existing.gigId], Date.now());
    }
    return c.body(null, 204);
  });
