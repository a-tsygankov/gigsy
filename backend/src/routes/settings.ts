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
import { eventShapeChanged } from "../calendar/event-shaping.ts";

export const settingsRouter = new Hono<{ Bindings: Bindings; Variables: AuthVars }>()
  .use("*", requireAuth)
  .get("/", async (c) => {
    const settings = await UsersRepo.for(c.env.DB).getSettings(c.get("userId"));
    return c.json(settings);
  })
  .patch("/", zValidator("json", SettingsPatchSchema), async (c) => {
    const userId = c.get("userId");
    const usersRepo = UsersRepo.for(c.env.DB);
    // The validator rejects unknown keys outright: a typo that appears
    // to save is worse than one that errors.
    const before = await usersRepo.getSettings(userId);
    const settings = await usersRepo.updateSettings(userId, c.req.valid("json"), Date.now());
    // A setting that changes how every event LOOKS has to reach the
    // events already on the calendar, not just the next gig edited —
    // see calendar/event-shaping.ts. Same reset a reconnect and
    // "Re-sync everything" perform: the next run reconsiders every gig.
    // The run itself is the cron's, or the webapp's "sync now" as it
    // leaves Settings; this route stays free of Google.
    if (eventShapeChanged(before, settings)) {
      await usersRepo.setLastCalendarSyncAt(userId, 0);
    }
    return c.json(settings);
  });
