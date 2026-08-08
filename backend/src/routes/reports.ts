import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { Bindings } from "../env.ts";
import { requireAuth, type AuthVars } from "../middleware/auth.ts";
import { entityId } from "../domain/schemas.ts";
import { reportSummary, type ReportFilters } from "../services/reports.ts";
import { dashboardSummary, type DashboardWindow } from "../services/dashboard.ts";

const SummaryQuery = z.object({
  from: z.coerce.number().int().nonnegative().optional(),
  to: z.coerce.number().int().nonnegative().optional(),
  clientId: entityId.optional(),
});

export const reportsRouter = new Hono<{ Bindings: Bindings; Variables: AuthVars }>()
  .use("*", requireAuth)
  .get("/summary", zValidator("query", SummaryQuery), async (c) => {
    const q = c.req.valid("query");
    const filters: ReportFilters = {
      ...(q.from !== undefined ? { from: q.from } : {}),
      ...(q.to !== undefined ? { to: q.to } : {}),
      ...(q.clientId !== undefined ? { clientId: q.clientId } : {}),
    };
    return c.json(await reportSummary(c.env.DB, c.get("userId"), filters));
  })
  .get(
    "/dashboard",
    zValidator(
      "query",
      z.object({
        futureFrom: z.coerce.number().int().nonnegative().optional(),
        futureTo: z.coerce.number().int().nonnegative().optional(),
      }),
    ),
    async (c) => {
      const q = c.req.valid("query");
      const window: DashboardWindow = {
        ...(q.futureFrom !== undefined ? { futureFrom: q.futureFrom } : {}),
        ...(q.futureTo !== undefined ? { futureTo: q.futureTo } : {}),
      };
      return c.json(await dashboardSummary(c.env.DB, c.get("userId"), window));
    },
  );
