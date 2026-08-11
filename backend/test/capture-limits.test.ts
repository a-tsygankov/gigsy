/// <reference types="@cloudflare/vitest-pool-workers" />
/**
 * What bounds the cost of capture.
 *
 * Both entry points spend the same budget — your AI provider key — so
 * both consult the same rule. Before this, the photo route enforced a
 * cap inline and the email handler had none, which only survived
 * because no address was reachable from the internet yet.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations, seedUser } from "./helpers/db.ts";
import { DraftsRepo } from "../src/repos/drafts.ts";
import {
  DEFAULT_DAILY_CAP,
  dailyCapFrom,
  hasCaptureBudget,
  startOfUtcDayMs,
} from "../src/capture/limits.ts";

const U1 = "capture-limit-user";

beforeAll(async () => {
  await applyMigrations(env.DB);
  await seedUser(env.DB, U1);
});

describe("dailyCapFrom", () => {
  it("uses the configured cap", () => {
    expect(dailyCapFrom({ AI_DAILY_CAP: "3" })).toBe(3);
  });

  it("falls back when unset or blank", () => {
    expect(dailyCapFrom({})).toBe(DEFAULT_DAILY_CAP);
    expect(dailyCapFrom({ AI_DAILY_CAP: "" })).toBe(DEFAULT_DAILY_CAP);
  });

  it("falls back rather than becoming NaN", () => {
    // NaN compares false against everything, so a typo in config would
    // have silently switched the cap off altogether.
    expect(dailyCapFrom({ AI_DAILY_CAP: "lots" })).toBe(DEFAULT_DAILY_CAP);
    expect(dailyCapFrom({ AI_DAILY_CAP: "0" })).toBe(DEFAULT_DAILY_CAP);
    expect(dailyCapFrom({ AI_DAILY_CAP: "-5" })).toBe(DEFAULT_DAILY_CAP);
  });
});

describe("startOfUtcDayMs", () => {
  it("truncates to UTC midnight", () => {
    const midnight = startOfUtcDayMs(Date.parse("2026-08-10T23:59:59.999Z"));
    expect(new Date(midnight).toISOString()).toBe("2026-08-10T00:00:00.000Z");
  });
});

describe("hasCaptureBudget", () => {
  async function addDrafts(count: number, at: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      await DraftsRepo.for(env.DB).insert(U1, {
        id: crypto.randomUUID(),
        source: "email",
        rawR2Key: null,
        extractedJson: "{}",
        now: at,
      });
    }
  }

  it("allows a user who has captured nothing today", async () => {
    expect(await hasCaptureBudget({ ...env, AI_DAILY_CAP: "2" }, U1)).toBe(true);
  });

  it("refuses once the cap is reached", async () => {
    await addDrafts(2, Date.now());

    expect(await hasCaptureBudget({ ...env, AI_DAILY_CAP: "2" }, U1)).toBe(false);
  });

  it("ignores drafts from previous days", async () => {
    // The cap is per UTC day, so yesterday's captures must not spend
    // today's budget.
    await addDrafts(5, startOfUtcDayMs() - 60_000);

    expect(await hasCaptureBudget({ ...env, AI_DAILY_CAP: "2" }, U1)).toBe(true);
  });

  it("counts per user, not globally", async () => {
    const other = "capture-limit-other";
    await seedUser(env.DB, other, "capture-limit-other@example.com");
    await addDrafts(5, Date.now());

    expect(await hasCaptureBudget({ ...env, AI_DAILY_CAP: "2" }, other)).toBe(true);
  });
});
