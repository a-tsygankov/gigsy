/**
 * User settings (docs/plan.md §13, Phase 11).
 *
 * GET always answers with a complete object — defaults filled — so the
 * client never has to know which settings existed when the row was
 * written. PATCH merges, so a client built against an older version
 * cannot wipe settings it has never heard of.
 */
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { Bindings } from "../env.ts";
import { requireAuth, type AuthVars } from "../middleware/auth.ts";
import { UsersRepo } from "../repos/users.ts";
import { SettingsPatchSchema } from "../domain/settings.ts";

export const settingsRouter = new Hono<{ Bindings: Bindings; Variables: AuthVars }>()
  .use("*", requireAuth)
  .get("/", async (c) => {
    const settings = await UsersRepo.for(c.env.DB).getSettings(c.get("userId"));
    return c.json(settings);
  })
  .patch("/", zValidator("json", SettingsPatchSchema), async (c) => {
    // The validator rejects unknown keys outright: a typo that appears
    // to save is worse than one that errors.
    const settings = await UsersRepo.for(c.env.DB).updateSettings(
      c.get("userId"),
      c.req.valid("json"),
      Date.now(),
    );
    return c.json(settings);
  });
