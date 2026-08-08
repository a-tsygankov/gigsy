import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { Bindings } from "../env.ts";
import { requireAuth, type AuthVars } from "../middleware/auth.ts";
import { ServiceInput, entityId } from "../domain/schemas.ts";
import { ServicesRepo } from "../repos/services.ts";
import { GigsRepo } from "../repos/gigs.ts";
import { PaymentsRepo } from "../repos/payments.ts";

export const servicesRouter = new Hono<{ Bindings: Bindings; Variables: AuthVars }>()
  .use("*", requireAuth)
  .get("/", async (c) => {
    const repo = ServicesRepo.for(c.env.DB);
    return c.json({ items: await repo.list(c.get("userId")) });
  })
  .get("/:id", async (c) => {
    const repo = ServicesRepo.for(c.env.DB);
    const record = await repo.get(c.get("userId"), c.req.param("id"));
    return record === null ? c.json({ error: "not found" }, 404) : c.json(record);
  })
  .put("/:id", zValidator("json", ServiceInput), async (c) => {
    const id = c.req.param("id");
    if (!entityId.safeParse(id).success) {
      return c.json({ error: "id must be a UUID" }, 400);
    }
    const userId = c.get("userId");
    const input = c.req.valid("json");

    // A service always belongs to one of the caller's gigs; a linked
    // payment must be theirs too.
    if ((await GigsRepo.for(c.env.DB).get(userId, input.gigId)) === null) {
      return c.json({ error: "gigId does not reference your gig" }, 400);
    }
    if (
      input.paymentId != null &&
      (await PaymentsRepo.for(c.env.DB).get(userId, input.paymentId)) === null
    ) {
      return c.json({ error: "paymentId does not reference your payment" }, 400);
    }

    const result = await ServicesRepo.for(c.env.DB).upsert(
      userId,
      id,
      {
        gigId: input.gigId,
        description: input.description,
        amountOfferedCents: input.amountOfferedCents ?? null,
        amountPaidCents: input.amountPaidCents ?? null,
        paymentId: input.paymentId ?? null,
        isCompleted: input.isCompleted,
      },
      { now: Date.now() },
    );
    if (result === "forbidden") return c.json({ error: "not found" }, 404);
    return c.json(result.record, result.created ? 201 : 200);
  })
  .delete("/:id", async (c) => {
    const repo = ServicesRepo.for(c.env.DB);
    const removed = await repo.remove(c.get("userId"), c.req.param("id"));
    return removed ? c.body(null, 204) : c.json({ error: "not found" }, 404);
  });
