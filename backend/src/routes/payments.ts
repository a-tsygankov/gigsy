import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { Bindings } from "../env.ts";
import { requireAuth, type AuthVars } from "../middleware/auth.ts";
import { PaymentInput, entityId } from "../domain/schemas.ts";
import { PaymentsRepo } from "../repos/payments.ts";
import { AllocationsRepo } from "../repos/allocations.ts";
import { recomputePaidTotals } from "../services/paid-totals.ts";
import { checkPaymentWrite } from "../services/payment-invariants.ts";

/** R2 key for a payment's confirmation object — user-prefixed so a
 * key can never point into another user's space. */
export function confirmationKey(userId: string, paymentId: string): string {
  return `u/${userId}/payments/${paymentId}/confirmation`;
}

export const paymentsRouter = new Hono<{ Bindings: Bindings; Variables: AuthVars }>()
  .use("*", requireAuth)
  .get("/", async (c) => {
    const repo = PaymentsRepo.for(c.env.DB);
    return c.json({ items: await repo.list(c.get("userId")) });
  })
  .get("/:id", async (c) => {
    const userId = c.get("userId");
    const repo = PaymentsRepo.for(c.env.DB);
    const record = await repo.get(userId, c.req.param("id"));
    if (record === null) return c.json({ error: "not found" }, 404);
    // Computed, not stored: the source of truth is the allocations
    // table, and a stored figure could drift from it.
    const allocations = await AllocationsRepo.for(c.env.DB).listByPayment(
      userId,
      record.id,
    );
    const allocatedCents = allocations.reduce((sum, a) => sum + a.amountCents, 0);
    return c.json({
      ...record,
      allocatedCents,
      unallocatedCents: record.amountCents - allocatedCents,
    });
  })
  .put("/:id", zValidator("json", PaymentInput), async (c) => {
    const id = c.req.param("id");
    if (!entityId.safeParse(id).success) {
      return c.json({ error: "id must be a UUID" }, 400);
    }
    const userId = c.get("userId");
    const input = c.req.valid("json");
    const now = Date.now();
    const paymentsRepo = PaymentsRepo.for(c.env.DB);
    const allocationsRepo = AllocationsRepo.for(c.env.DB);

    // Ownership of gigId/clientId, the client rule on the compat path
    // (I3), the shrink-below-allocated refusal (I4), and the
    // clientId-change conflict refusal (I5) — see
    // services/payment-invariants.ts. Shared with services/sync.ts's
    // "payment" case so the two doors can't diverge on what they
    // enforce or on the message they enforce it with.
    const check = await checkPaymentWrite(c.env.DB, userId, id, input);
    if (!check.ok) return c.json({ error: check.message }, 400);

    const result = await paymentsRepo.upsert(
      userId,
      id,
      {
        gigId: input.gigId ?? null,
        clientId: input.clientId,
        amountCents: input.amountCents,
        paidAt: input.paidAt ?? null,
        notes: input.notes ?? null,
      },
      { now },
    );
    if (result === "forbidden") return c.json({ error: "not found" }, 404);

    // A client that was offline across the allocations release still
    // sends payments.gigId. This route translates it into a single
    // allocation rather than refusing it, so a direct write through
    // this endpoint doesn't lose the link between the money and the
    // work. services/sync.ts's "payment" case does the same translation
    // for the outbox path — see that file for why it matters there too.
    // replaceSoleAllocation is keyed off the payment id, not any id the
    // client supplies, so replaying the same payment upsert converges
    // on one allocation instead of adding a second — see that method's
    // docstring for what it does to a payment that was previously split
    // across several gigs.
    if (input.gigId != null) {
      const affectedGigIds = await allocationsRepo.replaceSoleAllocation(
        userId,
        result.record.id,
        input.gigId,
        input.amountCents,
        now,
      );
      await recomputePaidTotals(c.env.DB, userId, affectedGigIds, now);
    }
    // A payload that omits gigId (or sends it as null) does not remove
    // an allocation the payment already has — same preserve-not-destroy
    // choice as clientId above. A bare edit to, say, notes should not
    // silently un-link money from work it was already tied to.

    return c.json(result.record, result.created ? 201 : 200);
  })
  .delete("/:id", async (c) => {
    const userId = c.get("userId");
    const id = c.req.param("id");
    const repo = PaymentsRepo.for(c.env.DB);
    // payment_allocations.payment_id references payments(id) with no
    // ON DELETE CASCADE, so the allocations have to go first or the
    // delete below fails with a FOREIGN KEY constraint error — which is
    // exactly what happened before this: any payment with at least one
    // allocation (which, after migration 0016's backfill, is every
    // payment that named a gig) 500'd on delete and left the gig's
    // derived total stale forever.
    const affectedGigIds = await AllocationsRepo.for(c.env.DB).removeAllForPayment(
      userId,
      id,
    );
    const removed = await repo.remove(userId, id);
    if (!removed) return c.json({ error: "not found" }, 404);
    if (affectedGigIds.length > 0) {
      await recomputePaidTotals(c.env.DB, userId, affectedGigIds, Date.now());
    }
    return c.body(null, 204);
  })
  // ── confirmation object (photo / mail proving the payment) ───────
  .put("/:id/confirmation", async (c) => {
    const userId = c.get("userId");
    const id = c.req.param("id");
    const repo = PaymentsRepo.for(c.env.DB);
    if ((await repo.get(userId, id)) === null) {
      return c.json({ error: "not found" }, 404);
    }
    const key = confirmationKey(userId, id);
    await c.env.RECEIPTS.put(key, c.req.raw.body, {
      httpMetadata: {
        contentType: c.req.header("content-type") ?? "application/octet-stream",
      },
    });
    await repo.setConfirmationKey(userId, id, key, Date.now());
    return c.json({ confirmationR2Key: key });
  })
  .get("/:id/confirmation", async (c) => {
    const userId = c.get("userId");
    const id = c.req.param("id");
    const record = await PaymentsRepo.for(c.env.DB).get(userId, id);
    if (record?.confirmationR2Key == null) {
      return c.json({ error: "not found" }, 404);
    }
    const object = await c.env.RECEIPTS.get(record.confirmationR2Key);
    if (object === null) return c.json({ error: "not found" }, 404);
    return new Response(object.body, {
      headers: {
        "content-type":
          object.httpMetadata?.contentType ?? "application/octet-stream",
        "cache-control": "private, max-age=60",
      },
    });
  });
