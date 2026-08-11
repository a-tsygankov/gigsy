import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { Bindings } from "../env.ts";
import { requireAuth, type AuthVars } from "../middleware/auth.ts";
import { GigInput, entityId } from "../domain/schemas.ts";
import { GigsRepo } from "../repos/gigs.ts";
import { ClientsRepo } from "../repos/clients.ts";

export const gigsRouter = new Hono<{ Bindings: Bindings; Variables: AuthVars }>()
  .use("*", requireAuth)
  .get("/", async (c) => {
    const repo = GigsRepo.for(c.env.DB);
    return c.json({ items: await repo.list(c.get("userId")) });
  })
  .get("/:id", async (c) => {
    const repo = GigsRepo.for(c.env.DB);
    const record = await repo.get(c.get("userId"), c.req.param("id"));
    return record === null ? c.json({ error: "not found" }, 404) : c.json(record);
  })
  .put("/:id", zValidator("json", GigInput), async (c) => {
    const id = c.req.param("id");
    if (!entityId.safeParse(id).success) {
      return c.json({ error: "id must be a UUID" }, 400);
    }
    const userId = c.get("userId");
    const input = c.req.valid("json");

    // A linked client must exist AND belong to the caller — a bad
    // link is a validation error, not a not-found.
    if (input.clientId != null) {
      const client = await ClientsRepo.for(c.env.DB).get(userId, input.clientId);
      if (client === null) {
        return c.json({ error: "clientId does not reference your client" }, 400);
      }
    }

    const repo = GigsRepo.for(c.env.DB);
    const result = await repo.upsert(
      userId,
      id,
      {
        clientId: input.clientId ?? null,
        title: input.title ?? null,
        status: input.status,
        location: input.location ?? null,
        dateTime: input.dateTime ?? null,
        durationMinutes: input.durationMinutes ?? null,
        amountOfferedCents: input.amountOfferedCents ?? null,
        amountPaidCents: input.amountPaidCents ?? null,
        notes: input.notes ?? null,
        source: input.source,
      },
      { now: Date.now() },
    );
    if (result === "forbidden") return c.json({ error: "not found" }, 404);
    return c.json(result.record, result.created ? 201 : 200);
  })
  .delete("/:id", async (c) => {
    const repo = GigsRepo.for(c.env.DB);
    const removed = await repo.remove(c.get("userId"), c.req.param("id"));
    return removed ? c.body(null, 204) : c.json({ error: "not found" }, 404);
  });
