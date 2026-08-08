/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import { requireAuth, type AuthVars } from "../src/middleware/auth.ts";
import { issueAccessToken } from "../src/auth/tokens.ts";
import type { Bindings } from "../src/env.ts";

// Probe app: one protected route that echoes the userId the
// middleware extracted.
function probeApp() {
  const app = new Hono<{ Bindings: Bindings; Variables: AuthVars }>();
  app.use("/whoami", requireAuth);
  app.get("/whoami", (c) => c.json({ userId: c.get("userId") }));
  return app;
}

async function tokenFor(userId: string) {
  return issueAccessToken({
    userId,
    secret: env.AUTH_SECRET,
    ttlSeconds: 900,
  });
}

describe("requireAuth", () => {
  it("401s without an Authorization header", async () => {
    const res = await probeApp().request("/whoami", {}, env);
    expect(res.status).toBe(401);
  });

  it("401s on a malformed Authorization header", async () => {
    const res = await probeApp().request(
      "/whoami",
      { headers: { Authorization: "Basic abc" } },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("401s on an invalid token", async () => {
    const res = await probeApp().request(
      "/whoami",
      { headers: { Authorization: "Bearer nope" } },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("401s on a token signed with the wrong secret", async () => {
    const token = await issueAccessToken({
      userId: "u1",
      secret: "wrong-secret",
      ttlSeconds: 900,
    });
    const res = await probeApp().request(
      "/whoami",
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("passes a valid token through and exposes the userId", async () => {
    const token = await tokenFor("user-42");
    const res = await probeApp().request(
      "/whoami",
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: "user-42" });
  });
});
