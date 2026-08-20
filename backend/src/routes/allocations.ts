import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { Bindings } from "../env.ts";
import { requireAuth, type AuthVars } from "../middleware/auth.ts";
import { AllocationInput, entityId } from "../domain/schemas.ts";
import { AllocationsRepo } from "../repos/allocations.ts";
import { recomputePaidTotals } from "../services/paid-totals.ts";
import { checkAllocationWrite } from "../services/payment-invariants.ts";

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

    // Ownership of paymentId/gigId, the client rule, and
    // over-allocation — see services/payment-invariants.ts. Shared with
    // services/sync.ts's "allocation" case so the two doors can't
    // diverge on what they enforce or on the message they enforce it
    // with.
    const check = await checkAllocationWrite(c.env.DB, userId, id, input);
    if (!check.ok) return c.json({ error: check.message }, 400);

    const allocationsRepo = AllocationsRepo.for(c.env.DB);
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

    // affectedGigIds already accounts for a moved allocation — see
    // checkAllocationWrite's docstring and services/payment-invariants.ts's
    // header comment (C1).
    await recomputePaidTotals(c.env.DB, userId, check.affectedGigIds, now);

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
