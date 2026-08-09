/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeAll, vi } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations, seedUser } from "./helpers/db.ts";
import { api } from "./helpers/api.ts";
import { runCalendarCron } from "../src/calendar/cron.ts";
import { encryptString } from "../src/auth/crypto.ts";
import { UsersRepo } from "../src/repos/users.ts";
import type { Bindings } from "../src/env.ts";

const U1 = "user-1";
const U2 = "user-2";
const GIG = "11111111-aaaa-4aaa-8aaa-111111111111";

async function connect(userId: string, refreshToken: string) {
  await UsersRepo.for(env.DB).setGoogleRefreshTokenEnc(
    userId,
    await encryptString(refreshToken, env.REFRESH_TOKEN_ENC_KEY),
    Date.now(),
  );
}

beforeAll(async () => {
  await applyMigrations(env.DB);
  await seedUser(env.DB, U1);
  await seedUser(env.DB, U2);
});

describe("runCalendarCron", () => {
  it("syncs every connected user; one failure doesn't stop the rest", async () => {
    await connect(U1, "rt-revoked");
    await connect(U2, "rt-good");
    await api(U2, "PUT", `/api/gigs/${GIG}`, {
      status: "confirmed",
      dateTime: 1757500000000,
    });

    const created: string[] = [];
    const summary = await runCalendarCron(env as unknown as Bindings, {
      mintAccessToken: vi.fn(async (opts: { refreshToken: string }) =>
        opts.refreshToken === "rt-revoked" ? "revoked" : { accessToken: "at" },
      ) as never,
      makeClient: () => ({
        createEvent: async () => {
          created.push("evt");
          return `evt-${created.length}`;
        },
        patchEvent: async () => true,
        deleteEvent: async () => true,
      }),
    });

    // U2 synced despite U1's revoked token…
    expect(created).toHaveLength(1);
    expect(summary.usersSynced).toBe(1);
    expect(summary.usersFailed).toBe(1);

    // …and U1 got disconnected instead of failing forever.
    const u1 = await UsersRepo.for(env.DB).get(U1);
    expect(u1?.googleRefreshTokenEnc).toBeNull();
  });

  it("does nothing when nobody is connected", async () => {
    const summary = await runCalendarCron(env as unknown as Bindings, {
      mintAccessToken: vi.fn() as never,
      makeClient: () => {
        throw new Error("should not be called");
      },
    });
    expect(summary).toEqual({ usersSynced: 0, usersFailed: 0 });
  });
});
