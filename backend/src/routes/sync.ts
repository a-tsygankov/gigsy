import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { Bindings } from "../env.ts";
import { requireAuth, type AuthVars } from "../middleware/auth.ts";
import { entityId } from "../domain/schemas.ts";
import { applySyncOps, type SyncOp } from "../services/sync.ts";

const opBase = {
  entity: z.enum(["client", "gig", "expense", "service", "payment", "allocation"]),
  id: entityId,
  modifiedAt: z.number().int().nonnegative(),
};

const SyncOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("upsert"), ...opBase, payload: z.unknown() }),
  z.object({ op: z.literal("delete"), ...opBase }),
]);

// Cap batches — the outbox drains in chunks; an unbounded batch is a
// runaway client, not a bigger sync.
const SyncRequest = z.object({ ops: z.array(SyncOpSchema).max(200) });

export const syncRouter = new Hono<{ Bindings: Bindings; Variables: AuthVars }>()
  .use("*", requireAuth)
  .post("/", zValidator("json", SyncRequest), async (c) => {
    const { ops } = c.req.valid("json");
    const results = await applySyncOps(
      c.env.DB,
      c.get("userId"),
      ops as SyncOp[],
      Date.now(),
    );
    return c.json({ results });
  });
