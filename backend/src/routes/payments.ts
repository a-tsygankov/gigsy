import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { Bindings } from "../env.ts";
import { requireAuth, type AuthVars } from "../middleware/auth.ts";
import { PaymentInput, entityId } from "../domain/schemas.ts";
import { PaymentsRepo } from "../repos/payments.ts";
import { GigsRepo, type GigRecord } from "../repos/gigs.ts";
import { ClientsRepo } from "../repos/clients.ts";
import { AllocationsRepo } from "../repos/allocations.ts";
import { recomputePaidTotals } from "../services/paid-totals.ts";

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

    let gig: GigRecord | null = null;
    if (input.gigId != null) {
      gig = await GigsRepo.for(c.env.DB).get(userId, input.gigId);
      if (gig === null) {
        return c.json({ error: "gigId does not reference your gig" }, 400);
      }
    }
    if (
      input.clientId != null &&
      (await ClientsRepo.for(c.env.DB).get(userId, input.clientId)) === null
    ) {
      return c.json({ error: "clientId does not reference your client" }, 400);
    }

    const existing = await paymentsRepo.get(userId, id);

    // The client rule applies here exactly as it does in
    // routes/allocations.ts: once the payment names a client — either
    // in this request, or already stored and left untouched because
    // `clientId` is absent from the payload — the gig the legacy
    // compat path below is about to allocate to must belong to that
    // client. Checked before any write, so a rejection here leaves
    // nothing half-changed.
    if (input.gigId != null) {
      const effectiveClientId =
        input.clientId !== undefined ? input.clientId : (existing?.clientId ?? null);
      if (effectiveClientId != null && gig!.clientId !== effectiveClientId) {
        return c.json({ error: "gigId does not reference the payment's client" }, 400);
      }
    }

    // Shrinking a payment below what is already allocated to it would
    // leave those allocations over-claiming money the payment no
    // longer has — the same invariant routes/allocations.ts enforces
    // from the other direction. Skipped when this request also carries
    // a gigId: the compat path below replaces every existing
    // allocation with a single one sized to the new amountCents, so
    // there is nothing stale left for this check to catch.
    if (input.gigId == null) {
      const currentAllocations = await allocationsRepo.listByPayment(userId, id);
      const allocatedCents = currentAllocations.reduce((sum, a) => sum + a.amountCents, 0);
      if (allocatedCents > input.amountCents) {
        return c.json(
          { error: "amountCents is less than the payment's allocated total" },
          400,
        );
      }
    }

    // Changing which client a payment came from, while it already has
    // allocations against gigs belonging to a *different* client, would
    // leave those allocations stale — pointing at gigs the payment's
    // new client rule says they shouldn't. Rather than silently
    // cascading a delete through someone's money records, this rejects
    // the clientId change outright; the caller has to clear the
    // conflicting allocations first. Narrowing to null is always safe
    // (a null-client payment allocates freely), so only a change to a
    // *different, non-null* client is checked.
    if (
      input.clientId !== undefined &&
      input.clientId != null &&
      existing !== null &&
      existing.clientId !== input.clientId
    ) {
      const currentAllocations = await allocationsRepo.listByPayment(userId, id);
      const allocatedGigIds = [...new Set(currentAllocations.map((a) => a.gigId))];
      const allocatedGigs = await Promise.all(
        allocatedGigIds.map((gigId) => GigsRepo.for(c.env.DB).get(userId, gigId)),
      );
      const conflicts = allocatedGigs.some(
        (g) => g === null || g.clientId !== input.clientId,
      );
      if (conflicts) {
        return c.json(
          {
            error:
              "clientId does not match one or more gigs this payment is already allocated to",
          },
          400,
        );
      }
    }

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
