/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeAll } from "vitest";
import { exchangeAuthCode, verifyGoogleIdToken } from "../src/auth/google.ts";
import { googlePayload, makeFakeGoogle, type FakeGoogle } from "./helpers/google.ts";

const CLIENT_ID = "gigsy-client-id.apps.googleusercontent.com";

let google: FakeGoogle;
beforeAll(async () => {
  google = await makeFakeGoogle();
});

const fetchJwks = async () => google.jwks;

describe("verifyGoogleIdToken", () => {
  it("accepts a valid token and returns sub + email", async () => {
    const idToken = await google.makeIdToken(googlePayload(CLIENT_ID));
    const claims = await verifyGoogleIdToken({ idToken, clientId: CLIENT_ID, fetchJwks });
    expect(claims).toEqual({ sub: "google-sub-123", email: "gig.worker@example.com" });
  });

  it("accepts the bare accounts.google.com issuer too", async () => {
    const idToken = await google.makeIdToken(
      googlePayload(CLIENT_ID, { iss: "accounts.google.com" }),
    );
    expect(
      await verifyGoogleIdToken({ idToken, clientId: CLIENT_ID, fetchJwks }),
    ).not.toBeNull();
  });

  it("rejects a token for a different audience", async () => {
    const idToken = await google.makeIdToken(
      googlePayload(CLIENT_ID, { aud: "someone-else" }),
    );
    expect(
      await verifyGoogleIdToken({ idToken, clientId: CLIENT_ID, fetchJwks }),
    ).toBeNull();
  });

  it("rejects a token from a different issuer", async () => {
    const idToken = await google.makeIdToken(
      googlePayload(CLIENT_ID, { iss: "https://evil.example.com" }),
    );
    expect(
      await verifyGoogleIdToken({ idToken, clientId: CLIENT_ID, fetchJwks }),
    ).toBeNull();
  });

  it("rejects an expired token", async () => {
    const past = Math.floor(Date.now() / 1000) - 7200;
    const idToken = await google.makeIdToken(
      googlePayload(CLIENT_ID, { iat: past, exp: past + 3600 }),
    );
    expect(
      await verifyGoogleIdToken({ idToken, clientId: CLIENT_ID, fetchJwks }),
    ).toBeNull();
  });

  it("rejects a token signed with an unknown kid", async () => {
    const idToken = await google.makeIdToken(googlePayload(CLIENT_ID), "other-kid");
    expect(
      await verifyGoogleIdToken({ idToken, clientId: CLIENT_ID, fetchJwks }),
    ).toBeNull();
  });

  it("rejects a token without an email claim", async () => {
    const idToken = await google.makeIdToken(
      googlePayload(CLIENT_ID, { email: undefined }),
    );
    expect(
      await verifyGoogleIdToken({ idToken, clientId: CLIENT_ID, fetchJwks }),
    ).toBeNull();
  });

  it("rejects garbage", async () => {
    expect(
      await verifyGoogleIdToken({ idToken: "nope", clientId: CLIENT_ID, fetchJwks }),
    ).toBeNull();
  });
});

describe("exchangeAuthCode", () => {
  const opts = {
    code: "auth-code-1",
    clientId: CLIENT_ID,
    clientSecret: "shhh",
    redirectUri: "postmessage",
  };

  it("POSTs the code to Google's token endpoint and returns the refresh token", async () => {
    let seenUrl = "";
    let seenBody = "";
    const fetchFn = (async (url: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(url);
      seenBody = String(init?.body);
      return new Response(
        JSON.stringify({ access_token: "at", refresh_token: "google-rt" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await exchangeAuthCode({ ...opts, fetchFn });

    expect(result).toEqual({ refreshToken: "google-rt" });
    expect(seenUrl).toBe("https://oauth2.googleapis.com/token");
    expect(seenBody).toContain("code=auth-code-1");
    expect(seenBody).toContain("grant_type=authorization_code");
  });

  it("returns null on a non-OK response", async () => {
    const fetchFn = (async () =>
      new Response("denied", { status: 400 })) as typeof fetch;
    expect(await exchangeAuthCode({ ...opts, fetchFn })).toBeNull();
  });

  it("returns null when Google omits the refresh token", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ access_token: "at" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    expect(await exchangeAuthCode({ ...opts, fetchFn })).toBeNull();
  });
});
