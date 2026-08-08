import { Hono } from "hono";
import type { Bindings } from "./env.ts";
import { log } from "./logger.ts";
import { versionRouter } from "./routes/version.ts";
import { debugRouter } from "./routes/debug.ts";
import { clientsRouter } from "./routes/clients.ts";
import { gigsRouter } from "./routes/gigs.ts";
import { expensesRouter } from "./routes/expenses.ts";
import { syncRouter } from "./routes/sync.ts";
import { reportsRouter } from "./routes/reports.ts";
import { makeAuthRouter } from "./routes/auth.ts";
import type { AuthVars } from "./middleware/auth.ts";

const app = new Hono<{ Bindings: Bindings; Variables: AuthVars }>();

// One JSON line per request (Workers Logs ingests these; the hidden
// console reads them back via /api/debug/logs). Skip the noisy
// /api/health probe and /api/debug/* itself — the console polling
// for logs must not generate the logs it displays.
app.use("*", async (c, next) => {
  const start = Date.now();
  await next();
  const path = new URL(c.req.url).pathname;
  if (path === "/api/health" || path.startsWith("/api/debug")) return;
  log.info("request", {
    method: c.req.method,
    path,
    status: c.res.status,
    durationMs: Date.now() - start,
  });
});

app.get("/api/health", (c) =>
  c.json({ ok: true, env: c.env.ENVIRONMENT, ts: Date.now() }),
);

app.route("/api/version", versionRouter);
app.route("/api/debug", debugRouter);

// User-scoped routers — each mounts requireAuth itself.
app.route("/api/clients", clientsRouter);
app.route("/api/gigs", gigsRouter);
app.route("/api/expenses", expensesRouter);
app.route("/api/sync", syncRouter);
app.route("/api/reports", reportsRouter);
app.route("/api/auth", makeAuthRouter());

export { app };

export default {
  fetch: app.fetch,

  // Calendar sync fan-out lands in Phase 6. Exporting the stub now
  // keeps the entry-point shape stable so enabling [triggers] in
  // wrangler.toml is a config-only change.
  async scheduled(_event, _env, _ctx) {},

  // Phase 5: Cloudflare Email Routing delivers per-user forwarding
  // addresses to an `email()` handler added here.
} satisfies ExportedHandler<Bindings>;
