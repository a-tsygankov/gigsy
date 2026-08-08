/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

describe("/api/health", () => {
  it("returns ok", async () => {
    const res = await SELF.fetch("https://localhost/api/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; env: string };
    expect(body.ok).toBe(true);
    expect(body.env).toBe("development");
  });

  it("404s unknown API routes", async () => {
    const res = await SELF.fetch("https://localhost/api/nope");
    expect(res.status).toBe(404);
  });
});
