import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { Bindings } from "../env.ts";
import { requireAuth, type AuthVars } from "../middleware/auth.ts";
import { ExpenseInput, entityId } from "../domain/schemas.ts";
import { ExpensesRepo } from "../repos/expenses.ts";
import { GigsRepo } from "../repos/gigs.ts";

export const expensesRouter = new Hono<{ Bindings: Bindings; Variables: AuthVars }>()
  .use("*", requireAuth)
  .get("/", async (c) => {
    const repo = ExpensesRepo.for(c.env.DB);
    return c.json({ items: await repo.list(c.get("userId")) });
  })
  .get("/:id", async (c) => {
    const repo = ExpensesRepo.for(c.env.DB);
    const record = await repo.get(c.get("userId"), c.req.param("id"));
    return record === null ? c.json({ error: "not found" }, 404) : c.json(record);
  })
  .put("/:id", zValidator("json", ExpenseInput), async (c) => {
    const id = c.req.param("id");
    if (!entityId.safeParse(id).success) {
      return c.json({ error: "id must be a UUID" }, 400);
    }
    const userId = c.get("userId");
    const input = c.req.valid("json");

    if (input.gigId != null) {
      const gig = await GigsRepo.for(c.env.DB).get(userId, input.gigId);
      if (gig === null) {
        return c.json({ error: "gigId does not reference your gig" }, 400);
      }
    }

    const repo = ExpensesRepo.for(c.env.DB);
    const result = await repo.upsert(
      userId,
      id,
      {
        gigId: input.gigId ?? null,
        amountCents: input.amountCents,
        category: input.category ?? null,
        receiptR2Key: input.receiptR2Key ?? null,
        notes: input.notes ?? null,
        reimbursable: input.reimbursable,
      },
      { now: Date.now() },
    );
    if (result === "forbidden") return c.json({ error: "not found" }, 404);
    return c.json(result.record, result.created ? 201 : 200);
  })
  .delete("/:id", async (c) => {
    const repo = ExpensesRepo.for(c.env.DB);
    const removed = await repo.remove(c.get("userId"), c.req.param("id"));
    return removed ? c.body(null, 204) : c.json({ error: "not found" }, 404);
  });
