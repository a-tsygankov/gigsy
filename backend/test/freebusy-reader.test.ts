/// <reference types="@cloudflare/vitest-pool-workers" />
/**
 * The bridge from a public page load to Google (Phase 12, Task 3).
 *
 * This is the only place where an unauthenticated stranger's request
 * makes Gigsy act on a user's behalf, so the tests here are mostly
 * about restraint: what it refuses to do, and what it refuses to
 * assume.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations, seedUser } from "./helpers/db.ts";
import { encryptString } from "../src/auth/crypto.ts";
import { UsersRepo } from "../src/repos/users.ts";
import {
  makeCalendarBusyReader,
  type FreeBusyDeps,
} from "../src/calendar/freebusy-reader.ts";
import type { FreeBusyResult } from "../src/calendar/google-calendar.ts";

const CONNECTED = "fb-reader-connected";
const DISCONNECTED = "fb-reader-disconnected";
const UNREADABLE = "fb-reader-unreadable";
const MIN = Date.parse("2026-08-10T00:00:00.000Z");
const MAX = Date.parse("2026-08-17T00:00:00.000Z");

interface Recorded {
  minted: number;
  queried: { calendarIds: string[]; timeMinMs: number; timeMaxMs: number }[];
}

/** Deps that record what was asked, so "never called" is assertable. */
function deps(
  over: {
    mint?: Awaited<ReturnType<FreeBusyDeps["mintAccessToken"]>>;
    freeBusy?: FreeBusyResult;
  } = {},
): FreeBusyDeps & { recorded: Recorded } {
  const recorded: Recorded = { minted: 0, queried: [] };
  return {
    recorded,
    mintAccessToken: async () => {
      recorded.minted++;
      return over.mint === undefined ? { accessToken: "at" } : over.mint;
    },
    queryFreeBusy: async (options) => {
      recorded.queried.push({
        calendarIds: options.calendarIds,
        timeMinMs: options.timeMinMs,
        timeMaxMs: options.timeMaxMs,
      });
      return over.freeBusy === undefined ? { busy: [] } : over.freeBusy;
    },
  };
}

/** Everything the public path must leave exactly as it found it. */
async function userRow(id: string) {
  return env.DB.prepare(
    "SELECT google_refresh_token_enc, modified_at FROM users WHERE id = ?",
  )
    .bind(id)
    .first<{ google_refresh_token_enc: string | null; modified_at: number }>();
}

beforeAll(async () => {
  await applyMigrations(env.DB);
  await seedUser(env.DB, CONNECTED);
  await seedUser(env.DB, DISCONNECTED, "fb-disconnected@example.com");
  await seedUser(env.DB, UNREADABLE, "fb-unreadable@example.com");

  await UsersRepo.for(env.DB).setGoogleRefreshTokenEnc(
    CONNECTED,
    await encryptString("real-refresh-token", env.REFRESH_TOKEN_ENC_KEY),
    Date.now(),
  );
  // Ciphertext from a different key — what a REFRESH_TOKEN_ENC_KEY
  // rotation leaves behind.
  await UsersRepo.for(env.DB).setGoogleRefreshTokenEnc(
    UNREADABLE,
    await encryptString("stale", "b3RoZXIta2V5LW90aGVyLWtleS1vdGhlci1rZXktb3Q="),
    Date.now(),
  );
});

describe("makeCalendarBusyReader", () => {
  it("asks about the primary calendar and the one gigs are written to", async () => {
    const d = deps();

    await makeCalendarBusyReader(env, d)(CONNECTED, MIN, MAX);

    expect(d.recorded.queried).toHaveLength(1);
    expect(d.recorded.queried[0]!.calendarIds).toEqual(["primary", "primary"]);
    expect(d.recorded.queried[0]!.timeMinMs).toBe(MIN);
    expect(d.recorded.queried[0]!.timeMaxMs).toBe(MAX);
  });

  it("passes the answer straight through", async () => {
    const busy = [{ start: MIN + 1000, end: MIN + 2000 }];
    const d = deps({ freeBusy: { busy } });

    const result = await makeCalendarBusyReader(env, d)(CONNECTED, MIN, MAX);

    expect(result).toEqual({ busy });
  });

  it("passes insufficient-scope through, so the caller can say gigs only", async () => {
    const d = deps({ freeBusy: "insufficient-scope" });

    expect(await makeCalendarBusyReader(env, d)(CONNECTED, MIN, MAX)).toBe(
      "insufficient-scope",
    );
  });

  it("does not reach Google at all for a user with no calendar connected", async () => {
    const d = deps();

    expect(await makeCalendarBusyReader(env, d)(DISCONNECTED, MIN, MAX)).toBeNull();
    expect(d.recorded.minted).toBe(0);
    expect(d.recorded.queried).toHaveLength(0);
  });

  it("gives up on a token it cannot decrypt", async () => {
    const d = deps();

    expect(await makeCalendarBusyReader(env, d)(UNREADABLE, MIN, MAX)).toBeNull();
    expect(d.recorded.minted).toBe(0);
  });

  it("gives up when the grant was revoked", async () => {
    const d = deps({ mint: "revoked" });

    expect(await makeCalendarBusyReader(env, d)(CONNECTED, MIN, MAX)).toBeNull();
  });

  it("gives up when Google cannot be reached", async () => {
    const d = deps({ mint: null });

    expect(await makeCalendarBusyReader(env, d)(CONNECTED, MIN, MAX)).toBeNull();
  });

  it("returns null, never an empty calendar, when it fails", async () => {
    // { busy: [] } would read as "your week is clear" and have the user
    // promising every hour of it.
    for (const d of [deps({ mint: "revoked" }), deps({ mint: null })]) {
      expect(await makeCalendarBusyReader(env, d)(CONNECTED, MIN, MAX)).not.toEqual({
        busy: [],
      });
    }
  });
});

/**
 * The rule that separates this from every other calendar path: a
 * stranger loading a link must not be able to change the user's
 * account. Elsewhere an unreadable or revoked token is cleared so the
 * UI can offer Connect again — correct when the user is there to see
 * it, and a silent disconnection triggered by a visitor if it happened
 * here.
 */
describe("makeCalendarBusyReader — the public path never writes", () => {
  it("leaves an unreadable token in place rather than self-healing", async () => {
    const before = await userRow(UNREADABLE);

    await makeCalendarBusyReader(env, deps())(UNREADABLE, MIN, MAX);

    expect(await userRow(UNREADABLE)).toEqual(before);
  });

  it("leaves a revoked grant connected", async () => {
    const before = await userRow(CONNECTED);

    await makeCalendarBusyReader(env, deps({ mint: "revoked" }))(CONNECTED, MIN, MAX);

    expect(await userRow(CONNECTED)).toEqual(before);
  });

  it("changes nothing on a perfectly successful read", async () => {
    const before = await userRow(CONNECTED);

    await makeCalendarBusyReader(env, deps())(CONNECTED, MIN, MAX);

    expect(await userRow(CONNECTED)).toEqual(before);
  });
});
