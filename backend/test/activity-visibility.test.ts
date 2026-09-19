/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/index.ts";
import { applyMigrations } from "./helpers/db.ts";
import {
  clampInterval,
  MAX_INTERVAL_MS,
  MAX_INTERVALS,
} from "../src/routes/activity.ts";

interface EventRow {
  user_id: string | null;
  ts: number;
  kind: string;
  duration_ms: number | null;
  detail_json: string | null;
  user_agent: string | null;
}

async function visibilityRows(): Promise<EventRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM activity_events WHERE kind = 'app.visible' ORDER BY ts",
  ).all<EventRow>();
  return results;
}

async function signIn(): Promise<string> {
  const res = await app.request(
    "/api/auth/test-login",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "someone@example.com" }),
    },
    env,
  );
  return ((await res.json()) as { accessToken: string }).accessToken;
}

let idSeq = 0;
function withId(i: { startedAt: number; endedAt: number }): {
  id: string;
  startedAt: number;
  endedAt: number;
} {
  // Deterministic but distinct — the server keys rows on this.
  idSeq++;
  return { id: `00000000-0000-4000-8000-${String(idSeq).padStart(12, "0")}`, ...i };
}

async function report(
  token: string,
  intervals: Array<{ startedAt: number; endedAt: number; id?: string }>,
): Promise<Response> {
  return app.request(
    "/api/activity/visibility",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        intervals: intervals.map((i) => (i.id === undefined ? withId(i) : i)),
      }),
    },
    env,
  );
}

beforeAll(async () => {
  await applyMigrations(env.DB);
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM activity_events").run();
});

describe("clampInterval", () => {
  const now = 1_000_000_000_000;

  it("accepts an ordinary interval and returns its length", () => {
    expect(clampInterval({ startedAt: now - 60_000, endedAt: now }, now)).toEqual({
      startedAt: now - 60_000,
      durationMs: 60_000,
    });
  });

  it("rejects a flick through the tab strip", () => {
    expect(clampInterval({ startedAt: now - 200, endedAt: now }, now)).toBeNull();
  });

  it("rejects a backwards interval", () => {
    expect(clampInterval({ startedAt: now, endedAt: now - 60_000 }, now)).toBeNull();
  });

  it("rejects one longer than a day", () => {
    const tooLong = { startedAt: now - MAX_INTERVAL_MS - 1000, endedAt: now };
    expect(clampInterval(tooLong, now)).toBeNull();
  });

  it("rejects a start in the future beyond tolerable skew", () => {
    const ahead = { startedAt: now + 60 * 60_000, endedAt: now + 61 * 60_000 };
    expect(clampInterval(ahead, now)).toBeNull();
  });

  it("tolerates a small forward skew", () => {
    const skewed = { startedAt: now + 30_000, endedAt: now + 90_000 };
    expect(clampInterval(skewed, now)).not.toBeNull();
  });

  it("rejects one older than the retention window", () => {
    const ancient = now - 200 * 24 * 60 * 60 * 1000;
    expect(
      clampInterval({ startedAt: ancient, endedAt: ancient + 60_000 }, now),
    ).toBeNull();
  });
});

describe("POST /api/activity/visibility", () => {
  it("refuses an unauthenticated report", async () => {
    const res = await app.request(
      "/api/activity/visibility",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intervals: [] }),
      },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("stores an interval as one row, with its length", async () => {
    const token = await signIn();
    const now = Date.now();
    const res = await report(token, [
      { startedAt: now - 120_000, endedAt: now - 60_000 },
    ]);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ accepted: 1, received: 1 });

    const rows = await visibilityRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ts).toBe(now - 120_000);
    expect(rows[0]?.duration_ms).toBe(60_000);
    expect(rows[0]?.user_id).not.toBeNull();
  });

  it("records how late the report arrived, so an offline flush is visible", async () => {
    const token = await signIn();
    const now = Date.now();
    // An hour-old interval: exactly what a reconnect after offline work
    // looks like.
    await report(token, [
      { startedAt: now - 3_600_000, endedAt: now - 3_540_000 },
    ]);

    const detail = JSON.parse((await visibilityRows())[0]!.detail_json!) as {
      reportedAfterMs: number;
    };
    expect(detail.reportedAfterMs).toBeGreaterThan(3_500_000);
  });

  it("reports live use as arriving immediately", async () => {
    const token = await signIn();
    const now = Date.now();
    await report(token, [{ startedAt: now - 60_000, endedAt: now }]);

    const detail = JSON.parse((await visibilityRows())[0]!.detail_json!) as {
      reportedAfterMs: number;
    };
    expect(detail.reportedAfterMs).toBeLessThan(5_000);
  });

  it("accepts a batch and drops only the bad ones", async () => {
    const token = await signIn();
    const now = Date.now();
    const res = await report(token, [
      { startedAt: now - 300_000, endedAt: now - 240_000 }, // good
      { startedAt: now - 100, endedAt: now }, // too short
      { startedAt: now, endedAt: now - 5000 }, // backwards
      { startedAt: now - 60_000, endedAt: now }, // good
    ]);

    expect(await res.json()).toMatchObject({ accepted: 2, received: 4 });
    expect(await visibilityRows()).toHaveLength(2);
  });

  it("refuses a batch larger than the cap rather than truncating it", async () => {
    const token = await signIn();
    const now = Date.now();
    const tooMany = Array.from({ length: MAX_INTERVALS + 1 }, (_, i) => ({
      startedAt: now - (i + 2) * 60_000,
      endedAt: now - (i + 1) * 60_000,
    }));
    const res = await report(token, tooMany);
    expect(res.status).toBe(400);
    expect(await visibilityRows()).toHaveLength(0);
  });

  it("attributes the time to the caller, never to a body-supplied id", async () => {
    const token = await signIn();
    const now = Date.now();
    await app.request(
      "/api/activity/visibility",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          userId: "somebody-else",
          intervals: [withId({ startedAt: now - 60_000, endedAt: now })],
        }),
      },
      env,
    );
    const rows = await visibilityRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.user_id).not.toBe("somebody-else");
  });

  it("does not record its own request as screen time", async () => {
    const token = await signIn();
    const now = Date.now();
    await report(token, [{ startedAt: now - 60_000, endedAt: now }]);
    // The api.request middleware still logs the POST — that is correct
    // — but it must not masquerade as an app.visible row.
    expect(await visibilityRows()).toHaveLength(1);
  });
});

describe("repeat reports", () => {
  it("stores an interval once however many times it is sent", async () => {
    // A flush whose response was lost is retried by the client. The
    // same id must not become a second helping of screen time.
    const token = await signIn();
    const now = Date.now();
    const interval = withId({ startedAt: now - 120_000, endedAt: now - 60_000 });

    await report(token, [interval]);
    await report(token, [interval]);
    await report(token, [interval]);

    const rows = await visibilityRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.duration_ms).toBe(60_000);
  });

  it("refuses an id that is not a uuid, so a row key cannot be chosen", async () => {
    const token = await signIn();
    const now = Date.now();
    const res = await report(token, [
      { id: "../../auth-login-row", startedAt: now - 60_000, endedAt: now },
    ]);
    expect(res.status).toBe(400);
    expect(await visibilityRows()).toHaveLength(0);
  });

  it("cannot overwrite a row the worker wrote", async () => {
    // Client ids are namespaced, so even a collision with a real row
    // id lands somewhere else entirely.
    const token = await signIn();
    const existing = await env.DB.prepare(
      "SELECT id FROM activity_events WHERE kind = 'auth.login' LIMIT 1",
    ).first<{ id: string }>();
    expect(existing).not.toBeNull();

    const now = Date.now();
    await report(token, [
      { id: existing!.id, startedAt: now - 60_000, endedAt: now },
    ]);

    const login = await env.DB.prepare(
      "SELECT kind FROM activity_events WHERE id = ?",
    )
      .bind(existing!.id)
      .first<{ kind: string }>();
    expect(login?.kind).toBe("auth.login");
    expect(await visibilityRows()).toHaveLength(1);
  });
});
