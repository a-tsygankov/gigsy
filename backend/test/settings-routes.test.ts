/// <reference types="@cloudflare/vitest-pool-workers" />
/**
 * /api/settings against the real worker and a real D1 (Phase 11).
 *
 * settings-domain.test.ts covers the parsing rules; this covers the
 * round trip — that a patch actually persists, that it merges against
 * what is stored rather than what the client happened to send, and that
 * one user cannot read or write another's.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { env, SELF } from "cloudflare:test";
import { applyMigrations, seedUser } from "./helpers/db.ts";
import { api } from "./helpers/api.ts";
import { DEFAULT_SETTINGS, type Settings } from "../src/domain/settings.ts";

const U1 = "settings-user-1";
const U2 = "settings-user-2";

async function getSettings(userId: string): Promise<Settings> {
  const res = await api(userId, "GET", "/api/settings");
  expect(res.status).toBe(200);
  return (await res.json()) as Settings;
}

async function patchSettings(
  userId: string,
  patch: Record<string, unknown>,
): Promise<Response> {
  return api(userId, "PATCH", "/api/settings", patch);
}

beforeAll(async () => {
  await applyMigrations(env.DB);
  await seedUser(env.DB, U1);
  await seedUser(env.DB, U2, "settings-two@example.com");
});

describe("GET /api/settings", () => {
  it("answers with a complete object for a user who has never saved", async () => {
    expect(await getSettings(U1)).toEqual(DEFAULT_SETTINGS);
  });

  it("refuses an unauthenticated request", async () => {
    const res = await SELF.fetch("https://localhost/api/settings");

    expect(res.status).toBe(401);
  });
});

describe("PATCH /api/settings", () => {
  it("persists a change and reads it back", async () => {
    const res = await patchSettings(U1, { currency: "EUR" });
    expect(res.status).toBe(200);

    expect((await getSettings(U1)).currency).toBe("EUR");
  });

  it("merges against what is stored, not what the client sent", async () => {
    await patchSettings(U1, { currency: "GBP" });
    await patchSettings(U1, { nudgeUnpaidDays: 30 });

    const settings = await getSettings(U1);

    // The second patch never mentioned currency; it must survive.
    expect(settings.currency).toBe("GBP");
    expect(settings.nudgeUnpaidDays).toBe(30);
    // And everything untouched is still at its default.
    expect(settings.calendarReminderMinutes).toBe(60);
  });

  it("returns the merged result, so the client needs no second request", async () => {
    // Self-contained: isolated storage rolls back per-test writes, so
    // nothing survives from the test above.
    await patchSettings(U1, { currency: "GBP" });

    const res = await patchSettings(U1, { calendarTitlePrefix: true });

    const body = (await res.json()) as Settings;
    expect(body.calendarTitlePrefix).toBe(true);
    expect(body.currency).toBe("GBP");
  });

  it("rejects an unknown key rather than storing it", async () => {
    await patchSettings(U1, { currency: "GBP" });

    const res = await patchSettings(U1, { curency: "CAD" });

    expect(res.status).toBe(400);
    // And nothing was written.
    expect((await getSettings(U1)).currency).toBe("GBP");
  });

  it("rejects a value outside its range", async () => {
    expect((await patchSettings(U1, { nudgeUnpaidDays: 0 })).status).toBe(400);
    expect((await patchSettings(U1, { calendarReminderMinutes: -1 })).status).toBe(400);
    expect((await patchSettings(U1, { currency: "dollars" })).status).toBe(400);
  });

  it("clears the optional gig duration with null", async () => {
    await patchSettings(U1, { defaultGigDurationMinutes: 240 });
    expect((await getSettings(U1)).defaultGigDurationMinutes).toBe(240);

    await patchSettings(U1, { defaultGigDurationMinutes: null });
    expect((await getSettings(U1)).defaultGigDurationMinutes).toBeNull();
  });

  // Optional delivery (2026-09-20): the global default for whether a
  // client's work needs delivering. Off by default — the dashboard's
  // "To deliver" tile stays empty for a user who never asked for it.
  it("defaults clientsExpectDelivery to false and round-trips a change", async () => {
    expect((await getSettings(U1)).clientsExpectDelivery).toBe(false);

    const res = await patchSettings(U1, { clientsExpectDelivery: true });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Settings).clientsExpectDelivery).toBe(true);

    expect((await getSettings(U1)).clientsExpectDelivery).toBe(true);
  });

  it("keeps one user's settings out of another's", async () => {
    await patchSettings(U1, { currency: "JPY" });

    // U2 never saved anything, so U2 still sees defaults.
    expect((await getSettings(U2)).currency).toBe("USD");
  });
});

/**
 * A setting that changes how every calendar event looks has to reach
 * the events already on the calendar. The sync only reconsiders gigs
 * stored since the watermark, and a settings change stores no gig —
 * so the route resets the watermark itself (calendar/event-shaping.ts)
 * and the next run rewrites every event with the new shape.
 */
describe("PATCH /api/settings — event-shaping settings reset the sync watermark", () => {
  const U3 = "settings-user-3";
  const WATERMARK = 1_700_000_000_000;

  beforeAll(async () => {
    await seedUser(env.DB, U3, "settings-three@example.com");
  });

  async function watermark(): Promise<number | null> {
    const row = await env.DB.prepare("SELECT last_calendar_sync_at AS w FROM users WHERE id = ?1")
      .bind(U3)
      .first<{ w: number | null }>();
    return row?.w ?? null;
  }

  it("resets it when the title prefix changes", async () => {
    await env.DB.prepare("UPDATE users SET last_calendar_sync_at = ?1 WHERE id = ?2")
      .bind(WATERMARK, U3)
      .run();
    expect((await patchSettings(U3, { calendarTitlePrefix: true })).status).toBe(200);
    expect(await watermark()).toBe(0);
  });

  it("resets it when a reminder setting changes", async () => {
    await env.DB.prepare("UPDATE users SET last_calendar_sync_at = ?1 WHERE id = ?2")
      .bind(WATERMARK, U3)
      .run();
    await patchSettings(U3, { calendarReminderMinutes: 30 });
    expect(await watermark()).toBe(0);
    await env.DB.prepare("UPDATE users SET last_calendar_sync_at = ?1 WHERE id = ?2")
      .bind(WATERMARK, U3)
      .run();
    await patchSettings(U3, { calendarUseDefaultReminder: true });
    expect(await watermark()).toBe(0);
  });

  it("leaves it alone for a setting that shapes no event", async () => {
    await env.DB.prepare("UPDATE users SET last_calendar_sync_at = ?1 WHERE id = ?2")
      .bind(WATERMARK, U3)
      .run();
    await patchSettings(U3, { nudgeUnpaidDays: 9 });
    expect(await watermark()).toBe(WATERMARK);
  });

  it("leaves it alone when the patch re-sends the value already stored", async () => {
    // A re-send is not a change, and a full rewrite of every event is
    // not free — a Google call per gig.
    await patchSettings(U3, { calendarTitlePrefix: true });
    await env.DB.prepare("UPDATE users SET last_calendar_sync_at = ?1 WHERE id = ?2")
      .bind(WATERMARK, U3)
      .run();
    await patchSettings(U3, { calendarTitlePrefix: true });
    expect(await watermark()).toBe(WATERMARK);
  });
});
