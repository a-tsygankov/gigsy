/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import { makeAuthRouter, type AuthDeps } from "../src/routes/auth.ts";
import { verifyAccessToken } from "../src/auth/tokens.ts";
import { decryptString } from "../src/auth/crypto.ts";
import { UsersRepo } from "../src/repos/users.ts";
import { applyMigrations } from "./helpers/db.ts";
import { googlePayload, makeFakeGoogle, type FakeGoogle } from "./helpers/google.ts";

const CLIENT_ID = "gigsy-client-id.apps.googleusercontent.com";
const GOOGLE_RT = "google-refresh-token-raw";

let google: FakeGoogle;

beforeAll(async () => {
  await applyMigrations(env.DB);
  google = await makeFakeGoogle();
});

function testEnv() {
  return { ...env, GOOGLE_CLIENT_ID: CLIENT_ID };
}

function appWith(depsOverrides: Partial<AuthDeps> = {}) {
  const deps: AuthDeps = {
    fetchJwks: async () => google.jwks,
    exchangeCode: async () => ({ refreshToken: GOOGLE_RT }),
    ...depsOverrides,
  };
  return new Hono().route("/api/auth", makeAuthRouter(deps));
}

async function post(
  app: Hono,
  path: string,
  body: unknown,
): Promise<Response> {
  return app.request(
    path,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    testEnv(),
  );
}

type LoginBody = {
  accessToken: string;
  refreshToken: string;
  user: { id: string; email: string };
};

async function login(app: Hono): Promise<LoginBody> {
  const idToken = await google.makeIdToken(googlePayload(CLIENT_ID));
  const res = await post(app, "/api/auth/google", { idToken });
  expect(res.status).toBe(200);
  return (await res.json()) as LoginBody;
}

describe("POST /api/auth/google", () => {
  it("verifies the ID token, upserts the user, and issues tokens", async () => {
    const app = appWith();
    const body = await login(app);

    expect(body.user.email).toBe("gig.worker@example.com");
    const claims = await verifyAccessToken({
      token: body.accessToken,
      secret: env.AUTH_SECRET,
    });
    expect(claims).toEqual({ userId: body.user.id });
    expect(body.refreshToken.length).toBeGreaterThanOrEqual(32);
  });

  it("returns the same user for repeat logins", async () => {
    const app = appWith();
    const first = await login(app);
    const second = await login(app);
    expect(second.user.id).toBe(first.user.id);
  });

  it("exchanges an auth code and stores the Google refresh token encrypted", async () => {
    const app = appWith();
    const idToken = await google.makeIdToken(googlePayload(CLIENT_ID));
    const res = await post(app, "/api/auth/google", {
      idToken,
      authCode: "one-time-code",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as LoginBody;

    const user = await UsersRepo.for(env.DB).get(body.user.id);
    expect(user?.googleRefreshTokenEnc).toBeTruthy();
    expect(user?.googleRefreshTokenEnc).not.toContain(GOOGLE_RT);
    expect(
      await decryptString(user!.googleRefreshTokenEnc!, env.REFRESH_TOKEN_ENC_KEY),
    ).toBe(GOOGLE_RT);
  });

  it("still logs in when the code exchange fails (calendar consent is optional)", async () => {
    const app = appWith({ exchangeCode: async () => null });
    const idToken = await google.makeIdToken(googlePayload(CLIENT_ID));
    const res = await post(app, "/api/auth/google", {
      idToken,
      authCode: "bad-code",
    });
    expect(res.status).toBe(200);
  });

  it("401s on an invalid ID token", async () => {
    const app = appWith();
    const res = await post(app, "/api/auth/google", { idToken: "garbage" });
    expect(res.status).toBe(401);
  });

  it("400s without an idToken", async () => {
    const app = appWith();
    const res = await post(app, "/api/auth/google", {});
    expect(res.status).toBe(400);
  });
});

describe("GET /api/auth/config", () => {
  it("is public and returns the Google client id", async () => {
    const app = appWith();
    const res = await app.request("/api/auth/config", {}, testEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ googleClientId: CLIENT_ID });
  });
});

describe("POST /api/auth/refresh", () => {
  it("rotates: old refresh token dies, the new pair works", async () => {
    const app = appWith();
    const session = await login(app);

    const res = await post(app, "/api/auth/refresh", {
      refreshToken: session.refreshToken,
    });
    expect(res.status).toBe(200);
    const rotated = (await res.json()) as LoginBody;

    // New access token is valid for the same user.
    const claims = await verifyAccessToken({
      token: rotated.accessToken,
      secret: env.AUTH_SECRET,
    });
    expect(claims).toEqual({ userId: session.user.id });

    // Old refresh token is consumed.
    const replay = await post(app, "/api/auth/refresh", {
      refreshToken: session.refreshToken,
    });
    expect(replay.status).toBe(401);

    // The rotated one still works.
    const again = await post(app, "/api/auth/refresh", {
      refreshToken: rotated.refreshToken,
    });
    expect(again.status).toBe(200);
  });

  it("401s on an unknown refresh token", async () => {
    const app = appWith();
    const res = await post(app, "/api/auth/refresh", {
      refreshToken: "never-issued",
    });
    expect(res.status).toBe(401);
  });
});
