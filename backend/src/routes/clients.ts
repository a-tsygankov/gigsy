import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { Bindings } from "../env.ts";
import { requireAuth, type AuthVars } from "../middleware/auth.ts";
import { ClientInput, entityId } from "../domain/schemas.ts";
import { ClientsRepo } from "../repos/clients.ts";

export const clientsRouter = new Hono<{ Bindings: Bindings; Variables: AuthVars }>()
  .use("*", requireAuth)
  .get("/", async (c) => {
    const repo = ClientsRepo.for(c.env.DB);
    return c.json({ items: await repo.list(c.get("userId")) });
  })
  .get("/:id", async (c) => {
    const repo = ClientsRepo.for(c.env.DB);
    const record = await repo.get(c.get("userId"), c.req.param("id"));
    return record === null ? c.json({ error: "not found" }, 404) : c.json(record);
  })
  .put("/:id", zValidator("json", ClientInput), async (c) => {
    const id = c.req.param("id");
    if (!entityId.safeParse(id).success) {
      return c.json({ error: "id must be a UUID" }, 400);
    }
    const input = c.req.valid("json");
    const repo = ClientsRepo.for(c.env.DB);
    const result = await repo.upsert(
      c.get("userId"),
      id,
      {
        name: input.name,
        contactInfo: input.contactInfo ?? null,
        notes: input.notes ?? null,
      },
      { now: Date.now() },
    );
    if (result === "forbidden") return c.json({ error: "not found" }, 404);
    return c.json(result.record, result.created ? 201 : 200);
  })
  .delete("/:id", async (c) => {
    const repo = ClientsRepo.for(c.env.DB);
    const removed = await repo.remove(c.get("userId"), c.req.param("id"));
    return removed ? c.body(null, 204) : c.json({ error: "not found" }, 404);
  });
