import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { Bindings } from "../env.ts";
import { requireAuth, type AuthVars } from "../middleware/auth.ts";
import { DraftsRepo, type DraftRecord } from "../repos/drafts.ts";

/** Wire shape: extracted_json goes out parsed, never as a string.
 * (Shared with the capture routes.) */
export function serializeDraft(draft: DraftRecord) {
  const { extractedJson, ...rest } = draft;
  return { ...rest, extracted: JSON.parse(extractedJson) as unknown };
}
const serialize = serializeDraft;

const StatusChange = z.object({ status: z.enum(["confirmed", "discarded"]) });
const ListQuery = z.object({
  status: z.enum(["pending", "confirmed", "discarded"]).optional(),
});

export const draftsRouter = new Hono<{ Bindings: Bindings; Variables: AuthVars }>()
  .use("*", requireAuth)
  .get("/", zValidator("query", ListQuery), async (c) => {
    const { status } = c.req.valid("query");
    const items = await DraftsRepo.for(c.env.DB).list(c.get("userId"), status);
    return c.json({ items: items.map(serialize) });
  })
  .get("/:id", async (c) => {
    const draft = await DraftsRepo.for(c.env.DB).get(
      c.get("userId"),
      c.req.param("id"),
    );
    return draft === null
      ? c.json({ error: "not found" }, 404)
      : c.json(serialize(draft));
  })
  .put("/:id", zValidator("json", StatusChange), async (c) => {
    const result = await DraftsRepo.for(c.env.DB).setStatus(
      c.get("userId"),
      c.req.param("id"),
      c.req.valid("json").status,
      Date.now(),
    );
    if (result === "not-found") return c.json({ error: "not found" }, 404);
    if (result === "conflict") {
      return c.json({ error: "draft already reviewed" }, 409);
    }
    return c.json(serialize(result));
  })
  .get("/:id/raw", async (c) => {
    const draft = await DraftsRepo.for(c.env.DB).get(
      c.get("userId"),
      c.req.param("id"),
    );
    if (draft?.rawR2Key == null) return c.json({ error: "not found" }, 404);
    const object = await c.env.RECEIPTS.get(draft.rawR2Key);
    if (object === null) return c.json({ error: "not found" }, 404);
    return new Response(object.body, {
      headers: {
        "content-type":
          object.httpMetadata?.contentType ?? "application/octet-stream",
        "cache-control": "private, max-age=300",
      },
    });
  });
