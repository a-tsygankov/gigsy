/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect } from "vitest";
import { SELF, env } from "cloudflare:test";
import pkg from "../package.json";
import { api } from "./helpers/api.ts";

type VersionBody = {
  worker: { version: string; env: string };
  schema: { version: string | null };
};

describe("GET /api/version", () => {
  it("reports the worker package version and environment", async () => {
    const res = await SELF.fetch("https://localhost/api/version");
    expect(res.status).toBe(200);
    const body = (await res.json()) as VersionBody;
    expect(body.worker.version).toBe(pkg.version);
    expect(body.worker.env).toBe("development");
  });

  it("reports schema version null when no migrations are applied", async () => {
    // Fresh test D1 has no d1_migrations table at all.
    const res = await SELF.fetch("https://localhost/api/version");
    const body = (await res.json()) as VersionBody;
    expect(body.schema.version).toBeNull();
  });

  it("reports the latest applied migration as the schema version", async () => {
    // Simulate wrangler's migration tracker.
    await env.DB.exec(
      "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)",
    );
    await env.DB.exec(
      "INSERT INTO d1_migrations (name, applied_at) VALUES ('0000_init.sql', '2026-01-01')",
    );
    await env.DB.exec(
      "INSERT INTO d1_migrations (name, applied_at) VALUES ('0001_more.sql', '2026-01-02')",
    );

    const res = await SELF.fetch("https://localhost/api/version");
    const body = (await res.json()) as VersionBody;
    expect(body.schema.version).toBe("0001_more.sql");
  });
});

describe("GET /api/debug/logs", () => {
  it("401s without a token (debug endpoints are JWT-guarded)", async () => {
    const res = await SELF.fetch("https://localhost/api/debug/logs");
    expect(res.status).toBe(401);
  });

  it("exposes recent request logs from the ring buffer", async () => {
    await SELF.fetch("https://localhost/api/some-page-to-log");

    const res = await api("debug-user", "GET", "/api/debug/logs");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entries: { msg: string; data?: { path?: string } }[];
    };
    expect(
      body.entries.some((e) => e.data?.path === "/api/some-page-to-log"),
    ).toBe(true);
  });

  it("does not log its own /api/debug requests (no feedback loop)", async () => {
    await api("debug-user", "GET", "/api/debug/logs");
    const res = await api("debug-user", "GET", "/api/debug/logs");
    const body = (await res.json()) as {
      entries: { data?: { path?: string } }[];
    };
    expect(
      body.entries.some((e) => e.data?.path?.startsWith("/api/debug")),
    ).toBe(false);
  });

  it("honours the limit query param, newest last", async () => {
    await SELF.fetch("https://localhost/api/first");
    await SELF.fetch("https://localhost/api/second");

    const res = await api("debug-user", "GET", "/api/debug/logs?limit=1");
    const body = (await res.json()) as {
      entries: { data?: { path?: string } }[];
    };
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]?.data?.path).toBe("/api/second");
  });
});
