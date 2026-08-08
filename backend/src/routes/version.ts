import { Hono } from "hono";
import type { Bindings } from "../env.ts";
import { WORKER_VERSION, getSchemaVersion } from "../version.ts";

/** GET /api/version — tier versions for the hidden console. The
 * client adds its own build-time version; this reports the tiers only
 * the worker can know. */
export const versionRouter = new Hono<{ Bindings: Bindings }>().get(
  "/",
  async (c) =>
    c.json({
      worker: { version: WORKER_VERSION, env: c.env.ENVIRONMENT },
      schema: { version: await getSchemaVersion(c.env.DB) },
    }),
);
