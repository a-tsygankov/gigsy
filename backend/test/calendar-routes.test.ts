/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeAll, vi } from "vitest";
import { SELF, env } from "cloudflare:test";
import { Hono } from "hono";
import { applyMigrations, seedUser } from "./helpers/db.ts";
import { issueAccessToken } from "../src/auth/tokens.ts";
import { decryptString, encryptString } from "../src/auth/crypto.ts";
import { UsersRepo } from "../src/repos/users.ts";
import { GigsRepo } from "../src/repos/gigs.ts";
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
  const calls: { op: string; event?: CalendarEventInput; eventId?: string }[] = [];
  return {
    calls,
    createEvent: async (event: CalendarEventInput) => {
      calls.push({ op: "create", event });
      return "evt-1";
    },
    patchEvent: async (eventId: string) => {
      calls.push({ op: "patch", eventId });
      return true;
    },
    deleteEvent: async (eventId: string) => {
      calls.push({ op: "delete", eventId });
      return true;
    },
  };
}

function appWith(overrides: Partial<CalendarDeps> = {}) {
  const client = recordingClient();
  const deps: CalendarDeps = {
    exchangeCode: vi.fn(async () => ({ refreshToken: "google-rt" })),
    mintAccessToken: vi.fn(async () => ({ accessToken: "google-at" })),
    makeClient: () => client,
    createCalendar: vi.fn(async () => "gigsy-cal@group.calendar.google.com"),
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

// A stored token that no longer decrypts — the everyday cause is
// rotating REFRESH_TOKEN_ENC_KEY (setup-secrets.ps1 -All regenerates
// it) after the calendar was connected. The old behaviour left the
// user permanently "Connected ✓" with nothing syncing and no way back:
// the Connect button only appears when disconnected.
describe("recovering a broken calendar connection", () => {
  const U2 = "user-2-broken";

  beforeAll(async () => {
    await seedUser(env.DB, U2);
  });

  it("status clears an unreadable token so the app offers Connect again", async () => {
    const repo = UsersRepo.for(env.DB);
    await repo.setGoogleRefreshTokenEnc(U1, "not-a-valid-ciphertext", Date.now());

    const { app } = appWith();
    const res = await call(app, "GET", "/api/calendar/status");

    expect(await res.json()).toEqual({ connected: false, lastSyncAt: null });
    // …and the garbage is gone, so it can't keep failing silently.
    expect((await repo.get(U1))?.googleRefreshTokenEnc).toBeNull();
  });

  it("disconnect clears a working connection on request", async () => {
    const { app } = appWith();
    await call(app, "POST", "/api/calendar/connect", { authCode: "code" });
    expect(
      ((await (await call(app, "GET", "/api/calendar/status")).json()) as {
        connected: boolean;
      }).connected,
    ).toBe(true);

    const res = await call(app, "DELETE", "/api/calendar/connection");
    expect(res.status).toBe(200);

    expect(
      ((await (await call(app, "GET", "/api/calendar/status")).json()) as {
        connected: boolean;
      }).connected,
    ).toBe(false);
  });

  it("disconnecting when never connected is not an error", async () => {
    const { app } = appWith();
    const res = await call(app, "DELETE", "/api/calendar/connection");
    expect(res.status).toBe(200);
  });
});

// Connecting means "put my gigs on this calendar". If the watermark
// survived a reconnect, only gigs touched since the last successful
// run would sync — an existing schedule would silently never appear,
// which is indistinguishable from the sync being broken.
describe("connecting resets the sync watermark", () => {
  it("clears lastCalendarSyncAt so the next run reconsiders every gig", async () => {
    const repo = UsersRepo.for(env.DB);
    await repo.setLastCalendarSyncAt(U1, Date.now());
    expect((await repo.get(U1))?.lastCalendarSyncAt).toBeGreaterThan(0);

    const { app } = appWith();
    await call(app, "POST", "/api/calendar/connect", { authCode: "code" });

    expect((await repo.get(U1))?.lastCalendarSyncAt).toBe(0);
  });
});

describe("POST /api/calendar/resync", () => {
  it("clears the watermark so the next run reconsiders every gig", async () => {
    const { app } = appWith();
    const usersRepo = UsersRepo.for(env.DB);
    await usersRepo.setLastCalendarSyncAt(U1, 1_700_000_000_000);

    const res = await call(app, "POST", "/api/calendar/resync");

    expect(res.status).toBe(200);
    expect((await usersRepo.get(U1))?.lastCalendarSyncAt).toBe(0);
  });

  it("does not sync, so it cannot half-fail", async () => {
    const { app, client } = appWith();

    await call(app, "POST", "/api/calendar/resync");

    // Making the next sync exhaustive is a different thing from syncing.
    expect(client.calls).toEqual([]);
  });
});

describe("POST /api/calendar/dedicated", () => {
  async function connect(): Promise<void> {
    await UsersRepo.for(env.DB).setGoogleRefreshTokenEnc(
      U1,
      await encryptString("google-rt", env.REFRESH_TOKEN_ENC_KEY),
      Date.now(),
    );
  }

  it("creates the calendar and points settings at it", async () => {
    await connect();
    const { app } = appWith();

    const res = await call(app, "POST", "/api/calendar/dedicated");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      calendarId: "gigsy-cal@group.calendar.google.com",
    });
    const settings = await UsersRepo.for(env.DB).getSettings(U1);
    expect(settings.calendarTargetId).toBe("gigsy-cal@group.calendar.google.com");
  });

  it("removes existing events from the calendar they actually live on", async () => {
    await connect();
    await api(U1, "PUT", `/api/gigs/${GIG}`, {
      status: "confirmed",
      dateTime: 1757500000000,
    });
    const gigsRepo = GigsRepo.for(env.DB);
    await gigsRepo.setCalendarEventId(U1, GIG, "old-event-1");

    const { app, client } = appWith();
    const res = await call(app, "POST", "/api/calendar/dedicated");

    expect(await res.json()).toMatchObject({ removed: 1, failed: 0 });
    expect(client.calls.some((c) => c.op === "delete")).toBe(true);
    // Ids are forgotten, so the next run re-creates them on the new
    // calendar rather than patching ids that live somewhere else.
    expect(await gigsRepo.listWithCalendarEvent(U1)).toEqual([]);
  });

  it("forces a full re-push onto the new calendar", async () => {
    await connect();
    await UsersRepo.for(env.DB).setLastCalendarSyncAt(U1, 1_700_000_000_000);
    const { app } = appWith();

    await call(app, "POST", "/api/calendar/dedicated");

    expect((await UsersRepo.for(env.DB).get(U1))?.lastCalendarSyncAt).toBe(0);
  });

  it("asks for re-consent when the grant only covers events", async () => {
    await connect();
    const { app } = appWith({
      createCalendar: vi.fn(async () => "insufficient-scope" as const),
    });

    const res = await call(app, "POST", "/api/calendar/dedicated");

    // Its own code, so the UI can re-prompt for consent rather than
    // saying "something went wrong".
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "reconnect-required" });
    // Nothing was switched.
    expect((await UsersRepo.for(env.DB).getSettings(U1)).calendarTargetId).toBe(
      "primary",
    );
  });

  it("409s when no calendar is connected", async () => {
    const { app } = appWith();

    const res = await call(app, "POST", "/api/calendar/dedicated");

    expect(res.status).toBe(409);
  });
});
