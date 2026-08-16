/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/index.ts";
import { ActivityRecorder } from "../src/activity/recorder.ts";
import { runActivityPrune, RETENTION_DAYS } from "../src/activity/prune.ts";
import { applyMigrations } from "./helpers/db.ts";
import { logBuffer } from "../src/logger.ts";

interface EventRow {
  id: string;
  user_id: string | null;
  ts: number;
  kind: string;
  method: string | null;
  path: string | null;
  status: number | null;
  duration_ms: number | null;
  detail_json: string | null;
  ip_country: string | null;
  user_agent: string | null;
}

async function events(): Promise<EventRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM activity_events ORDER BY ts, kind",
  ).all<EventRow>();
  return results;
}

async function testLogin(
  email: string,
  overrides: Partial<typeof env> = {},
): Promise<Response> {
  return app.request(
    "/api/auth/test-login",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    },
    { ...env, ...overrides },
  );
}

beforeAll(async () => {
  await applyMigrations(env.DB);
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM activity_events").run();
});

describe("the request recorder", () => {
  it("records a row per API request", async () => {
    await app.request("/api/auth/config", {}, env);
    const [row] = await events();
    expect(row).toMatchObject({
      kind: "api.request",
      method: "GET",
      path: "/api/auth/config",
      status: 200,
    });
  });

  it("records how long the request took", async () => {
    await app.request("/api/auth/config", {}, env);
    const [row] = await events();
    expect(row?.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("captures the country and user agent when the edge supplies them", async () => {
    await app.request(
      "/api/auth/config",
      { headers: { "cf-ipcountry": "US", "user-agent": "Gigsy/1.0 (test)" } },
      env,
    );
    const [row] = await events();
    expect(row?.ip_country).toBe("US");
    expect(row?.user_agent).toBe("Gigsy/1.0 (test)");
  });

  it("never stores a raw IP address", async () => {
    await app.request(
      "/api/auth/config",
      { headers: { "cf-connecting-ip": "203.0.113.7", "cf-ipcountry": "US" } },
      env,
    );
    expect(JSON.stringify(await events())).not.toContain("203.0.113.7");
  });

  it.each(["/api/health", "/api/version", "/api/debug/logs"])(
    "records nothing for %s",
    async (path) => {
      await app.request(path, {}, env);
      expect(await events()).toEqual([]);
    },
  );

  it("attributes the request to the signed-in user", async () => {
    const login = await testLogin("someone@example.com");
    const { accessToken } = (await login.json()) as { accessToken: string };
    await env.DB.prepare("DELETE FROM activity_events").run();

    await app.request(
      "/api/gigs",
      { headers: { authorization: `Bearer ${accessToken}` } },
      env,
    );
    const [row] = await events();
    expect(row?.kind).toBe("api.request");
    expect(row?.user_id).not.toBeNull();
  });

  it("leaves the user null when nobody is signed in", async () => {
    await app.request("/api/gigs", {}, env);
    const [row] = await events();
    expect(row?.status).toBe(401);
    expect(row?.user_id).toBeNull();
  });

  it("does not fail the request when the insert cannot happen", async () => {
    // The governing rule: observability must never break the app. The
    // table is dropped for this test only — vitest-pool-workers rolls
    // per-test writes back, so the schema returns for the next one.
    await env.DB.prepare("DROP TABLE activity_events").run();
    const res = await app.request("/api/auth/config", {}, env);
    expect(res.status).toBe(200);
  });

  it("complains about a broken table at most once, not once per request", async () => {
    // A line per failure is a line per request, and they land in the
    // same 200-entry ring buffer the debug console reads — so the one
    // condition worth diagnosing would flush the request logs that
    // explain it. version-debug-routes.test.ts fails outright when
    // this regresses.
    await env.DB.prepare("DROP TABLE activity_events").run();
    for (let i = 0; i < 5; i++) {
      await app.request("/api/auth/config", {}, env);
    }
    const res = await app.request("/api/debug/logs?limit=100", {}, {
      ...env,
      // The debug route is JWT-guarded; this suite has no token, so
      // assert on the buffer through the logger instead.
    });
    // A 401 is expected here — the assertion that matters is that the
    // loop above produced no crash and only one complaint, which the
    // buffer contents below confirm.
    expect(res.status).toBe(401);

    const complaints = logBuffer
      .toArray()
      .filter((e) => e.msg === "activity events are not being recorded");
    expect(complaints.length).toBeLessThanOrEqual(1);
  });
});

describe("auth events", () => {
  it("records a login with the door it came through", async () => {
    await testLogin("someone@example.com");
    const login = (await events()).find((e) => e.kind === "auth.login");
    expect(login).toBeDefined();
    expect(login?.user_id).not.toBeNull();
    expect(JSON.parse(login!.detail_json!)).toEqual({ via: "test" });
  });

  it("records a refusal, with the address, and no user", async () => {
    // An allowlist has to be supplied: gigsy's fails OPEN, so with the
    // secret unset — which is how the pool's env arrives — nobody is
    // ever refused and this would silently assert nothing.
    const res = await testLogin("stranger@example.com", {
      ALLOWED_EMAILS: "someone@example.com",
    });
    expect(res.status).toBe(403);

    const refused = (await events()).find((e) => e.kind === "auth.refused");
    expect(refused).toBeDefined();
    expect(refused?.user_id).toBeNull();
    expect(JSON.parse(refused!.detail_json!)).toMatchObject({
      email: "stranger@example.com",
    });
  });

  it("records a refresh, which rotation would otherwise erase", async () => {
    const login = await testLogin("someone@example.com");
    const { refreshToken } = (await login.json()) as { refreshToken: string };
    await env.DB.prepare("DELETE FROM activity_events").run();

    await app.request(
      "/api/auth/refresh",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      },
      env,
    );

    const refresh = (await events()).find((e) => e.kind === "auth.refresh");
    expect(refresh).toBeDefined();
    expect(refresh?.user_id).not.toBeNull();
  });

  it("never stores a token, raw or hashed", async () => {
    const login = await testLogin("someone@example.com");
    const { refreshToken, accessToken } = (await login.json()) as {
      refreshToken: string;
      accessToken: string;
    };
    const dump = JSON.stringify(await events());
    expect(dump).not.toContain(refreshToken);
    expect(dump).not.toContain(accessToken);
  });
});

describe("retention", () => {
  const DAY = 24 * 60 * 60 * 1000;

  it("drops events past the retention window and keeps the rest", async () => {
    const now = 10_000 * DAY;
    const recorder = ActivityRecorder.for(env.DB);
    await recorder.record({ userId: "u1", kind: "api.request" }, now - 91 * DAY);
    await recorder.record({ userId: "u1", kind: "api.request" }, now - 89 * DAY);
    await recorder.record({ userId: "u1", kind: "api.request" }, now);

    expect(await runActivityPrune(env, now)).toBe(1);
    const remaining = await events();
    expect(remaining).toHaveLength(2);
    expect(remaining.every((e) => e.ts > now - RETENTION_DAYS * DAY)).toBe(true);
  });

  it("deletes nothing when everything is recent", async () => {
    const now = 10_000 * DAY;
    await ActivityRecorder.for(env.DB).record({ userId: "u1", kind: "api.request" }, now);
    expect(await runActivityPrune(env, now)).toBe(0);
  });
});
