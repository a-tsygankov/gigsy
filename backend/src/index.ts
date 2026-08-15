import { Hono } from "hono";
import type { Bindings } from "./env.ts";
import { log } from "./logger.ts";
import { versionRouter } from "./routes/version.ts";
import { debugRouter } from "./routes/debug.ts";
import { clientsRouter } from "./routes/clients.ts";
import { gigsRouter } from "./routes/gigs.ts";
import { expensesRouter } from "./routes/expenses.ts";
import { servicesRouter } from "./routes/services.ts";
import { geoRouter } from "./routes/geo.ts";
import { pushRouter } from "./routes/push.ts";
import { settingsRouter } from "./routes/settings.ts";
import { paymentsRouter } from "./routes/payments.ts";
import { syncRouter } from "./routes/sync.ts";
import { reportsRouter } from "./routes/reports.ts";
import { draftsRouter } from "./routes/drafts.ts";
import { makeCaptureRouter } from "./routes/capture.ts";
import { makeCalendarRouter } from "./routes/calendar.ts";
import { makeAvailabilityRouter } from "./routes/availability.ts";
import { makeAvailabilityLinkRouter } from "./routes/availability-link.ts";
import { runCalendarCron } from "./calendar/cron.ts";
import { runPushCron } from "./push/cron.ts";
import { makeAuthRouter } from "./routes/auth.ts";
import { handleCapturedEmail } from "./capture/email-capture.ts";
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

// Public availability (Phase 12). Mounted apart from everything below
// and above the auth boundary on purpose: it is the only user-scoped
// route with no requireAuth, and the token in its path is the entire
// access control. It serves free ranges and a chosen display name —
// never a client, a place or an amount.
app.route("/api/a", makeAvailabilityRouter());

// User-scoped routers — each mounts requireAuth itself.
app.route("/api/clients", clientsRouter);
app.route("/api/gigs", gigsRouter);
app.route("/api/expenses", expensesRouter);
app.route("/api/services", servicesRouter);
app.route("/api/payments", paymentsRouter);
app.route("/api/sync", syncRouter);
app.route("/api/settings", settingsRouter);
// The owner's side of the public page above: mint, inspect, revoke.
app.route("/api/availability/link", makeAvailabilityLinkRouter());
app.route("/api/reports", reportsRouter);
app.route("/api/drafts", draftsRouter);
app.route("/api/capture", makeCaptureRouter());
app.route("/api/calendar", makeCalendarRouter());
app.route("/api/geo", geoRouter);
app.route("/api/push", pushRouter);
app.route("/api/auth", makeAuthRouter());

export { app };

export default {
  fetch: app.fetch,

  // Calendar sync fan-out (docs/plan.md §9) — [triggers] in
  // wrangler.toml fires this every 15 minutes.
  async scheduled(_event, env, ctx) {
    // Calendar first: a nudge should reflect the state the user is
    // about to see, and the two passes are independent otherwise.
    ctx.waitUntil(
      runCalendarCron(env).then(() => runPushCron(env)),
    );
  },

  // Email capture (docs/plan.md §8): Cloudflare Email Routing
  // delivers each user's forwarding address u-<userId>@<domain> here.
  // Activation is dashboard-side once a domain with Email Routing
  // exists (still-open handoff item) — the handler itself is live.
  async email(message, env, _ctx) {
    await handleCapturedEmail(message, env);
  },
} satisfies ExportedHandler<Bindings>;
