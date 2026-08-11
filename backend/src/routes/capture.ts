import { Hono } from "hono";
import type { Bindings } from "../env.ts";
import { requireAuth, type AuthVars } from "../middleware/auth.ts";
import { DraftsRepo } from "../repos/drafts.ts";
import { serializeDraft } from "./drafts.ts";
import { providerFromEnv } from "../capture/providers.ts";
import type { ExtractionProvider } from "../capture/extraction.ts";
import { createDraftFromCapture, toBase64 } from "../capture/capture-service.ts";
import { hasCaptureBudget } from "../capture/limits.ts";
import { captureAddressFor } from "../capture/address.ts";

export type ProviderFactory = (env: Bindings) => ExtractionProvider;

/** Photo capture (docs/plan.md §8). DI'd provider factory so tests
 * can inject failures; production uses the configured provider. */
export function makeCaptureRouter(
  providerFactory: ProviderFactory = providerFromEnv,
) {
  return new Hono<{ Bindings: Bindings; Variables: AuthVars }>()
    .use("*", requireAuth)
    /**
     * Where to forward a booking email.
     *
     * null means the deployment has no capture domain configured, and
     * the screen says capture is off — an address that would bounce is
     * worse than none, because someone will type it into a mail client
     * and trust it.
     */
    .get("/address", (c) =>
      c.json({
        address: captureAddressFor(c.get("userId"), c.env.CAPTURE_EMAIL_DOMAIN),
      }),
    )
    .post("/photo", async (c) => {
      const userId = c.get("userId");

      // Cost control: captures per user per UTC day. Shared with the
      // email handler so the two cannot drift — they spend the same
      // provider key.
      if (!(await hasCaptureBudget(c.env, userId))) {
        return c.json({ error: "daily capture limit reached" }, 429);
      }

      const bytes = new Uint8Array(await c.req.arrayBuffer());
      if (bytes.length === 0) return c.json({ error: "empty body" }, 400);
      const mimeType = c.req.header("content-type") ?? "application/octet-stream";

      const result = await createDraftFromCapture(c.env, userId, {
        source: "photo",
        rawBytes: bytes,
        rawContentType: mimeType,
        provider: providerFactory(c.env),
        input: { kind: "image", mimeType, dataBase64: toBase64(bytes) },
      });
      if (result === "extraction-failed") {
        return c.json({ error: "extraction failed — try again" }, 502);
      }
      return c.json(serializeDraft(result));
    });
}
