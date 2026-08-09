/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeAll, vi } from "vitest";
import { SELF, env } from "cloudflare:test";
import { Hono } from "hono";
import { applyMigrations, seedUser } from "./helpers/db.ts";
import { issueAccessToken } from "../src/auth/tokens.ts";
import { decryptString } from "../src/auth/crypto.ts";
import { UsersRepo } from "../src/repos/users.ts";
import { api } from "./helpers/api.ts";
import {
  makeCalendarRouter,
  type CalendarDeps,
} from "../src/routes/calendar.ts";
import type { Bindings } from "../src/env.ts";
import type { CalendarEventInput } from "../src/calendar/google-calendar.ts";

const U1 = "user-1";
const GIG = "11111111-aaaa-4aaa-8aaa-111111111111";

function recordingClient() {
  const calls: { op: string; event?: CalendarEventInput }[] = [];
  return {
    calls,
    createEvent: async (event: CalendarEventInput) => {
      calls.push({ op: "create", event });
      return "evt-1";
    },
    patchEvent: async () => true,
    deleteEvent: async () => true,
  };
}

function appWith(overrides: Partial<CalendarDeps> = {}) {
  const client = recordingClient();
  const deps: CalendarDeps = {
    exchangeCode: vi.fn(async () => ({ refreshToken: "google-rt" })),
    mintAccessToken: vi.fn(async () => ({ accessToken: "google-at" })),
    makeClient: () => client,
    ...overrides,
  };
  const app = new Hono().route("/api/calendar", makeCalendarRouter(deps));
  return { app, deps, client };
}

async function call(
  app: Hono,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const token = await issueAccessToken({
    userId: U1,
    secret: env.AUTH_SECRET,
    ttlSeconds: 900,
  });
  return app.request(
    path,
    {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    },
    env as unknown as Bindings,
  );
}

beforeAll(async () => {
  await applyMigrations(env.DB);
  await seedUser(env.DB, U1);
});

describe("/api/calendar", () => {
  it("401s without a token", async () => {
    const res = await SELF.fetch("https://localhost/api/calendar/status");
    expect(res.status).toBe(401);
  });

  it("status starts disconnected", async () => {
    const { app } = appWith();
    const res = await call(app, "GET", "/api/calendar/status");
    expect(await res.json()).toEqual({ connected: false, lastSyncAt: null });
  });

  it("connect exchanges the code and stores the token encrypted", async () => {
    const { app } = appWith();
    const res = await call(app, "POST", "/api/calendar/connect", {
      authCode: "one-time-code",
    });
    expect(res.status).toBe(200);

    const user = await UsersRepo.for(env.DB).get(U1);
    expect(user?.googleRefreshTokenEnc).toBeTruthy();
    expect(user?.googleRefreshTokenEnc).not.toContain("google-rt");
    expect(
      await decryptString(user!.googleRefreshTokenEnc!, env.REFRESH_TOKEN_ENC_KEY),
    ).toBe("google-rt");

    const status = await call(app, "GET", "/api/calendar/status");
    expect(((await status.json()) as { connected: boolean }).connected).toBe(true);
  });

  it("connect with a failed exchange is a 400", async () => {
    const { app } = appWith({ exchangeCode: vi.fn(async () => null) });
    const res = await call(app, "POST", "/api/calendar/connect", {
      authCode: "bad",
    });
    expect(res.status).toBe(400);
  });

  it("sync-now without a connection is a 409", async () => {
    const { app } = appWith();
    const res = await call(app, "POST", "/api/calendar/sync-now");
    expect(res.status).toBe(409);
  });

  it("sync-now mints a token from the stored secret and syncs gigs", async () => {
    const { app, deps, client } = appWith();
    await call(app, "POST", "/api/calendar/connect", { authCode: "code" });
    await api(U1, "PUT", `/api/gigs/${GIG}`, {
      status: "confirmed",
      dateTime: 1757500000000,
      location: "Costco on 5th",
    });

    const res = await call(app, "POST", "/api/calendar/sync-now");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { created: number }).created).toBe(1);

    // Minted from the DECRYPTED refresh token.
    expect(deps.mintAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({ refreshToken: "google-rt" }),
    );
    expect(client.calls[0]?.op).toBe("create");
  });

  it("a revoked refresh token disconnects the user (409 + cleared)", async () => {
    const { app } = appWith({
      mintAccessToken: vi.fn(async () => "revoked" as const),
    });
    await call(app, "POST", "/api/calendar/connect", { authCode: "code" });

    const res = await call(app, "POST", "/api/calendar/sync-now");
    expect(res.status).toBe(409);

    const status = await call(app, "GET", "/api/calendar/status");
    expect(((await status.json()) as { connected: boolean }).connected).toBe(false);
  });
});
