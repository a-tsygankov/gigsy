/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations, seedUser } from "./helpers/db.ts";
import { PushSubscriptionsRepo } from "../src/repos/push-subscriptions.ts";

const U1 = "push-user-1";
const U2 = "push-user-2";
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc123";

beforeAll(async () => {
  await applyMigrations(env.DB);
  await seedUser(env.DB, U1);
  await seedUser(env.DB, U2);
});

describe("PushSubscriptionsRepo", () => {
  it("stores a subscription and lists it for its user", async () => {
    const repo = PushSubscriptionsRepo.for(env.DB);
    await repo.save(U1, { endpoint: ENDPOINT, p256dh: "key-1", auth: "auth-1" }, 1);

    const rows = await repo.list(U1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.endpoint).toBe(ENDPOINT);
    expect(rows[0]?.p256dh).toBe("key-1");
  });

  // Re-subscribing is routine — permission changes, key rotation, the
  // push service expiring one — so it must replace, not accumulate.
  it("replaces rather than duplicates when the same endpoint re-subscribes", async () => {
    const repo = PushSubscriptionsRepo.for(env.DB);
    await repo.save(U1, { endpoint: ENDPOINT, p256dh: "key-1", auth: "auth-1" }, 1);
    await repo.save(U1, { endpoint: ENDPOINT, p256dh: "key-2", auth: "auth-2" }, 2);

    const rows = await repo.list(U1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.p256dh).toBe("key-2");
  });

  it("supports several devices for one user", async () => {
    const repo = PushSubscriptionsRepo.for(env.DB);
    await repo.save(U1, { endpoint: ENDPOINT, p256dh: "k", auth: "a" }, 1);
    await repo.save(
      U1,
      { endpoint: `${ENDPOINT}-phone`, p256dh: "k", auth: "a" },
      1,
    );

    expect(await repo.list(U1)).toHaveLength(2);
  });

  it("keeps subscriptions user-scoped", async () => {
    const repo = PushSubscriptionsRepo.for(env.DB);
    await repo.save(U1, { endpoint: ENDPOINT, p256dh: "k", auth: "a" }, 1);
    expect(await repo.list(U2)).toHaveLength(0);
  });

  // A shared device signing in as someone else must not keep pushing
  // the previous user's gigs to it.
  it("reassigns an endpoint that a different user re-subscribes", async () => {
    const repo = PushSubscriptionsRepo.for(env.DB);
    await repo.save(U1, { endpoint: ENDPOINT, p256dh: "k", auth: "a" }, 1);
    await repo.save(U2, { endpoint: ENDPOINT, p256dh: "k", auth: "a" }, 2);

    expect(await repo.list(U1)).toHaveLength(0);
    expect(await repo.list(U2)).toHaveLength(1);
  });

  it("removes a subscription on opt-out and on pruning", async () => {
    const repo = PushSubscriptionsRepo.for(env.DB);
    await repo.save(U1, { endpoint: ENDPOINT, p256dh: "k", auth: "a" }, 1);

    await repo.remove(U1, ENDPOINT);
    expect(await repo.list(U1)).toHaveLength(0);

    await repo.save(U1, { endpoint: ENDPOINT, p256dh: "k", auth: "a" }, 1);
    await repo.removeByEndpoint(ENDPOINT);
    expect(await repo.list(U1)).toHaveLength(0);
  });
});
