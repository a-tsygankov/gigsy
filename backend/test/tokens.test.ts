/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect } from "vitest";
import { issueAccessToken, verifyAccessToken } from "../src/auth/tokens.ts";

const SECRET = "test-secret-do-not-ship";

describe("access tokens", () => {
  it("round-trips: issued token verifies to its userId", async () => {
    const token = await issueAccessToken({
      userId: "user-1",
      secret: SECRET,
      ttlSeconds: 900,
    });
    const claims = await verifyAccessToken({ token, secret: SECRET });
    expect(claims).toEqual({ userId: "user-1" });
  });

  it("rejects an expired token", async () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    const token = await issueAccessToken({
      userId: "user-1",
      secret: SECRET,
      ttlSeconds: 60,
      nowSeconds: past,
    });
    expect(await verifyAccessToken({ token, secret: SECRET })).toBeNull();
  });

  it("rejects a token signed with another secret", async () => {
    const token = await issueAccessToken({
      userId: "user-1",
      secret: "other-secret",
      ttlSeconds: 900,
    });
    expect(await verifyAccessToken({ token, secret: SECRET })).toBeNull();
  });

  it("rejects garbage", async () => {
    expect(
      await verifyAccessToken({ token: "not.a.jwt", secret: SECRET }),
    ).toBeNull();
  });

  it("rejects a token without a sub claim", async () => {
    // Manually build a sub-less token via the same lib the impl uses.
    const { sign } = await import("hono/jwt");
    const token = await sign(
      { exp: Math.floor(Date.now() / 1000) + 900 },
      SECRET,
    );
    expect(await verifyAccessToken({ token, secret: SECRET })).toBeNull();
  });
});
