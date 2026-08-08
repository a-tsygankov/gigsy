import { describe, it, expect } from "vitest";
import { AuthApiClient } from "./api.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("AuthApiClient.testLogin", () => {
  it("POSTs the email and returns the session", async () => {
    let seenUrl = "";
    let seenBody = "";
    const fetchFn = (async (url: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(url);
      seenBody = String(init?.body);
      return jsonResponse({
        accessToken: "at",
        refreshToken: "rt",
        user: { id: "u1", email: "e2e@test.local" },
      });
    }) as typeof fetch;

    const session = await new AuthApiClient(fetchFn).testLogin("e2e@test.local");

    expect(seenUrl).toBe("/api/auth/test-login");
    expect(JSON.parse(seenBody)).toEqual({ email: "e2e@test.local" });
    expect(session.user.id).toBe("u1");
  });

  it("throws on a 404 (production — bypass does not exist)", async () => {
    const fetchFn = (async () =>
      jsonResponse({ error: "not found" }, 404)) as typeof fetch;
    await expect(
      new AuthApiClient(fetchFn).testLogin("e2e@test.local"),
    ).rejects.toThrow();
  });
});
