/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations, seedUser } from "./helpers/db.ts";
import { api } from "./helpers/api.ts";
import { runPushCron } from "../src/push/cron.ts";
import { PushSubscriptionsRepo } from "../src/repos/push-subscriptions.ts";
import { UsersRepo } from "../src/repos/users.ts";
import type { Bindings } from "../src/env.ts";
import type { PushResult } from "../src/push/sender.ts";

const U1 = "pushcron-user-1";
const GIG = "c1111111-1111-4111-8111-111111111111";
const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_780_000_000_000;

function envWith(overrides: Partial<Bindings> = {}): Bindings {
  return {
    ...(env as unknown as Bindings),
    VAPID_PUBLIC_KEY: "public-key",
    VAPID_PRIVATE_KEY: "private-key",
    ...overrides,
  };
}

/** Records what would have been delivered, without any network. */
function sender(result: PushResult = "sent") {
  const sent: { endpoint: string; payload: string }[] = [];
  return {
    sent,
    send: vi.fn(async (target: { endpoint: string }, payload: string) => {
      sent.push({ endpoint: target.endpoint, payload });
      return result;
    }),
  };
}

async function subscribe(endpoint: string) {
  await PushSubscriptionsRepo.for(env.DB).save(
    U1,
    { endpoint, p256dh: "k", auth: "a" },
    NOW,
  );
}

async function unpaidGig() {
  await api(U1, "PUT", `/api/gigs/${GIG}`, {
    status: "completed",
    amountOfferedCents: 19000,
  });
  await env.DB.prepare("UPDATE gigs SET modified_at = ? WHERE id = ?")
    .bind(NOW - 30 * DAY, GIG)
    .run();
}

beforeAll(async () => {
  await applyMigrations(env.DB);
  await seedUser(env.DB, U1);
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM push_subscriptions").run();
  await env.DB.prepare("DELETE FROM gigs WHERE user_id = ?").bind(U1).run();
  await env.DB.prepare(
    "UPDATE users SET last_push_at = NULL, last_push_key = NULL WHERE id = ?",
  )
    .bind(U1)
    .run();
});

describe("runPushCron", () => {
  it("does nothing at all without VAPID keys configured", async () => {
    await subscribe("https://push.example/1");
    await unpaidGig();
    const push = sender();

    const summary = await runPushCron(
      envWith({ VAPID_PUBLIC_KEY: "", VAPID_PRIVATE_KEY: "" }),
      NOW,
      { send: push.send },
    );

    expect(push.send).not.toHaveBeenCalled();
    expect(summary.notified).toBe(0);
  });

  it("delivers a nudge and records what it said", async () => {
    await subscribe("https://push.example/1");
    await unpaidGig();
    const push = sender();

    const summary = await runPushCron(envWith(), NOW, { send: push.send });

    expect(summary.notified).toBe(1);
    const payload = JSON.parse(push.sent[0]!.payload) as { body: string; path: string };
    expect(payload.body).toContain("$190.00");
    expect(payload.path).toBe(`/gigs/${GIG}`);

    const user = await UsersRepo.for(env.DB).get(U1);
    expect(user?.lastPushKey).toBe(`unpaid:${GIG}`);
    expect(user?.lastPushAt).toBe(NOW);
  });

  it("reaches every device the user has", async () => {
    await subscribe("https://push.example/phone");
    await subscribe("https://push.example/laptop");
    await unpaidGig();
    const push = sender();

    await runPushCron(envWith(), NOW, { send: push.send });

    expect(push.sent.map((s) => s.endpoint).sort()).toEqual([
      "https://push.example/laptop",
      "https://push.example/phone",
    ]);
  });

  it("stays silent when there is nothing to say", async () => {
    await subscribe("https://push.example/1");
    const push = sender();

    const summary = await runPushCron(envWith(), NOW, { send: push.send });

    expect(push.send).not.toHaveBeenCalled();
    expect(summary.notified).toBe(0);
  });

  it("skips a user already nudged today", async () => {
    await subscribe("https://push.example/1");
    await unpaidGig();
    await UsersRepo.for(env.DB).setLastPush(U1, "something-else", NOW - 60_000);
    const push = sender();

    const summary = await runPushCron(envWith(), NOW, { send: push.send });

    expect(push.send).not.toHaveBeenCalled();
    expect(summary.skipped).toBe(1);
  });

  it("prunes a dead subscription instead of retrying it forever", async () => {
    await subscribe("https://push.example/dead");
    await unpaidGig();
    const push = sender("gone");

    const summary = await runPushCron(envWith(), NOW, { send: push.send });

    expect(summary.pruned).toBe(1);
    expect(await PushSubscriptionsRepo.for(env.DB).list(U1)).toHaveLength(0);
  });

  // Marking the user as notified when nothing arrived would silence
  // tomorrow's attempt too.
  it("does not record a nudge that never reached a device", async () => {
    await subscribe("https://push.example/1");
    await unpaidGig();
    const push = sender("failed");

    const summary = await runPushCron(envWith(), NOW, { send: push.send });

    expect(summary.notified).toBe(0);
    expect((await UsersRepo.for(env.DB).get(U1))?.lastPushAt).toBeNull();
  });

  it("ignores users with no subscriptions at all", async () => {
    await unpaidGig();
    const push = sender();

    await runPushCron(envWith(), NOW, { send: push.send });

    expect(push.send).not.toHaveBeenCalled();
  });
});
