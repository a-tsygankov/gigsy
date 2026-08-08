import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { Bindings } from "../env.ts";
import { requireAuth, type AuthVars } from "../middleware/auth.ts";
import { PaymentInput, entityId } from "../domain/schemas.ts";
import { PaymentsRepo } from "../repos/payments.ts";
import { GigsRepo } from "../repos/gigs.ts";

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
    const repo = PaymentsRepo.for(c.env.DB);
    const record = await repo.get(c.get("userId"), c.req.param("id"));
    return record === null ? c.json({ error: "not found" }, 404) : c.json(record);
  })
  .put("/:id", zValidator("json", PaymentInput), async (c) => {
    const id = c.req.param("id");
    if (!entityId.safeParse(id).success) {
      return c.json({ error: "id must be a UUID" }, 400);
    }
    const userId = c.get("userId");
    const input = c.req.valid("json");

    if (
      input.gigId != null &&
      (await GigsRepo.for(c.env.DB).get(userId, input.gigId)) === null
    ) {
      return c.json({ error: "gigId does not reference your gig" }, 400);
    }

    const result = await PaymentsRepo.for(c.env.DB).upsert(
      userId,
      id,
      {
        gigId: input.gigId ?? null,
        amountCents: input.amountCents,
        paidAt: input.paidAt ?? null,
        notes: input.notes ?? null,
      },
      { now: Date.now() },
    );
    if (result === "forbidden") return c.json({ error: "not found" }, 404);
    return c.json(result.record, result.created ? 201 : 200);
  })
  .delete("/:id", async (c) => {
    const repo = PaymentsRepo.for(c.env.DB);
    const removed = await repo.remove(c.get("userId"), c.req.param("id"));
    return removed ? c.body(null, 204) : c.json({ error: "not found" }, 404);
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
