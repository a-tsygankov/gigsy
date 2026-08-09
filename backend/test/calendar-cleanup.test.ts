/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations, seedUser } from "./helpers/db.ts";
import { api } from "./helpers/api.ts";
import { GigsRepo } from "../src/repos/gigs.ts";
import { CalendarCleanupRepo } from "../src/repos/calendar-cleanup.ts";

const U1 = "cleanup-user-1";
const U2 = "cleanup-user-2";
const G1 = "61111111-1111-4111-8111-111111111111";
const G2 = "62222222-2222-4222-8222-222222222222";
const G3 = "63333333-3333-4333-8333-333333333333";

beforeAll(async () => {
  await applyMigrations(env.DB);
  await seedUser(env.DB, U1);
  await seedUser(env.DB, U2);
});

// A gig's calendar_event_id lives on the gig row, so deleting the gig
// destroys the only pointer to the Google event. remove() parks it in
// the cleanup queue first — the v1 orphaning limitation this closes.
describe("calendar cleanup queue", () => {
  it("queues the event id when a synced gig is deleted", async () => {
    const gigs = GigsRepo.for(env.DB);
    const cleanup = CalendarCleanupRepo.for(env.DB);

    await api(U1, "PUT", `/api/gigs/${G1}`, {
      status: "confirmed",
      dateTime: Date.now(),
    });
    await gigs.setCalendarEventId(U1, G1, "evt-to-clean");

    expect(await gigs.remove(U1, G1)).toBe(true);

    const pending = await cleanup.listPending(U1);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.calendarEventId).toBe("evt-to-clean");
  });

  it("queues nothing for a gig that never reached the calendar", async () => {
    const gigs = GigsRepo.for(env.DB);
    const cleanup = CalendarCleanupRepo.for(env.DB);

    await api(U1, "PUT", `/api/gigs/${G2}`, { status: "lead" });
    await gigs.remove(U1, G2);

    expect(await cleanup.listPending(U1)).toHaveLength(0);
  });

  // Offline deletes drain through /api/sync, not the DELETE route —
  // in an offline-first app that is the common path.
  it("queues on the offline sync delete path too", async () => {
    const gigs = GigsRepo.for(env.DB);
    const cleanup = CalendarCleanupRepo.for(env.DB);

    await api(U1, "PUT", `/api/gigs/${G3}`, {
      status: "confirmed",
      dateTime: Date.now(),
    });
    await gigs.setCalendarEventId(U1, G3, "evt-from-sync");

    const res = await api(U1, "POST", "/api/sync", {
      ops: [{ op: "delete", entity: "gig", id: G3, modifiedAt: Date.now() }],
    });
    expect(res.status).toBe(200);

    const ids = (await cleanup.listPending(U1)).map((r) => r.calendarEventId);
    expect(ids).toContain("evt-from-sync");
  });

  it("keeps queues user-scoped", async () => {
    expect(await CalendarCleanupRepo.for(env.DB).listPending(U2)).toHaveLength(0);
  });

  it("clears a row once its event is gone", async () => {
    const cleanup = CalendarCleanupRepo.for(env.DB);
    await cleanup.enqueue(U2, "evt-transient", Date.now());

    const [row] = await cleanup.listPending(U2);
    expect(row).toBeDefined();
    await cleanup.remove(U2, row!.id);

    expect(await cleanup.listPending(U2)).toHaveLength(0);
  });
});
