import { describe, it, expect } from "vitest";
import pkg from "../../package.json";
import { CLIENT_VERSION, fetchTierVersions } from "./versions.ts";

describe("CLIENT_VERSION", () => {
  it("matches the webapp package version", () => {
    expect(CLIENT_VERSION).toBe(pkg.version);
  });
});

describe("fetchTierVersions", () => {
  it("combines the client version with worker-reported tiers", async () => {
    const stub = async () =>
      new Response(
        JSON.stringify({
          worker: { version: "9.9.9", env: "production" },
          schema: { version: "0002_x.sql" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const v = await fetchTierVersions(stub as typeof fetch);

    expect(v).toEqual({
      client: pkg.version,
      worker: "9.9.9",
      schema: "0002_x.sql",
      env: "production",
    });
  });

  it("degrades to nulls when the API is unreachable (offline-first)", async () => {
    const stub = async () => {
      throw new Error("network down");
    };

    const v = await fetchTierVersions(stub as typeof fetch);

    expect(v).toEqual({ client: pkg.version, worker: null, schema: null, env: null });
  });

  it("degrades to nulls on a non-OK response", async () => {
    const stub = async () => new Response("nope", { status: 500 });

    const v = await fetchTierVersions(stub as typeof fetch);

    expect(v.worker).toBeNull();
    expect(v.client).toBe(pkg.version);
  });
});
