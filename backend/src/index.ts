import { Hono } from "hono";
import type { Bindings } from "./env.ts";

const app = new Hono<{ Bindings: Bindings }>();

// One JSON line per request (Workers Logs ingests these). Skip the
// noisy /api/health probe; everything else logs method+path+status.
app.use("*", async (c, next) => {
  const start = Date.now();
  await next();
  const path = new URL(c.req.url).pathname;
  if (path === "/api/health") return;
  console.log(
    JSON.stringify({
      evt: "request",
      method: c.req.method,
      path,
      status: c.res.status,
      durationMs: Date.now() - start,
    }),
  );
});

app.get("/api/health", (c) =>
  c.json({ ok: true, env: c.env.ENVIRONMENT, ts: Date.now() }),
);

// Phase 1+ routers mount here (docs/plan.md §5):
//   app.route("/api/auth", authRouter);
//   app.route("/api/clients", clientsRouter);
//   app.route("/api/gigs", gigsRouter);
//   app.route("/api/expenses", expensesRouter);
//   app.route("/api/sync", syncRouter);

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
