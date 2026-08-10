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
import { paymentsRouter } from "./routes/payments.ts";
import { syncRouter } from "./routes/sync.ts";
import PostalMime from "postal-mime";
import { reportsRouter } from "./routes/reports.ts";
import { draftsRouter } from "./routes/drafts.ts";
import { makeCaptureRouter } from "./routes/capture.ts";
import { makeCalendarRouter } from "./routes/calendar.ts";
import { runCalendarCron } from "./calendar/cron.ts";
import { runPushCron } from "./push/cron.ts";
import { makeAuthRouter } from "./routes/auth.ts";
import { UsersRepo } from "./repos/users.ts";
import { providerFromEnv } from "./capture/providers.ts";
import { createDraftFromCapture } from "./capture/capture-service.ts";
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
app.route("/api/services", servicesRouter);
app.route("/api/payments", paymentsRouter);
app.route("/api/sync", syncRouter);
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
    const local = (message.to.split("@")[0] ?? "").toLowerCase();
    if (!local.startsWith("u-")) {
      message.setReject("Unknown recipient");
      return;
    }
    const user = await UsersRepo.for(env.DB).get(local.slice(2));
    if (user === null) {
      message.setReject("Unknown recipient");
      return;
    }

    const rawBytes = new Uint8Array(await new Response(message.raw).arrayBuffer());
    const parsed = await PostalMime.parse(rawBytes);
    const text = [parsed.subject ?? "", parsed.text ?? ""].join("\n\n").trim();

    const result = await createDraftFromCapture(env, user.id, {
      source: "email",
      rawBytes,
      rawContentType: "message/rfc822",
      provider: providerFromEnv(env),
      input: { kind: "text", text },
      // Never silently drop a user's mail: a failed extraction still
      // yields a reviewable draft pointing at the original.
      fallbackExtracted: {
        kind: "unknown",
        notes: "Extraction failed — open the original email below.",
      },
    });
    if (result === "extraction-failed") {
      log.warn("email capture failed", { userId: user.id });
    } else {
      log.info("email captured", { userId: user.id, draftId: result.id });
    }
  },
} satisfies ExportedHandler<Bindings>;
