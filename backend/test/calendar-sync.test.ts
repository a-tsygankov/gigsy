/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations, seedUser } from "./helpers/db.ts";
import { api } from "./helpers/api.ts";
import { syncUserGigs } from "../src/calendar/sync-service.ts";
import { UsersRepo } from "../src/repos/users.ts";
import { CalendarCleanupRepo } from "../src/repos/calendar-cleanup.ts";
import type { CalendarEventInput } from "../src/calendar/google-calendar.ts";

const U1 = "user-1";
const GIG = "11111111-aaaa-4aaa-8aaa-111111111111";
const ACME = "22222222-cccc-4ccc-8ccc-222222222222";
const WHEN = 1757500000000;
const FOUR_H = 4 * 60 * 60 * 1000;

/** Recording stub with controllable failures. */
function stubClient(failCreate = false) {
  const calls: { op: string; eventId?: string; event?: CalendarEventInput }[] = [];
  let nextId = 0;
  return {
    calls,
    createEvent: async (event: CalendarEventInput) => {
      calls.push({ op: "create", event });
      return failCreate ? null : `evt-${++nextId}`;
    },
    patchEvent: async (eventId: string, event: CalendarEventInput) => {
      calls.push({ op: "patch", eventId, event });
      return true;
    },
    deleteEvent: async (eventId: string) => {
      calls.push({ op: "delete", eventId });
      return true;
    },
  };
}

async function gigEventId(): Promise<string | null> {
  const gig = (await (await api(U1, "GET", `/api/gigs/${GIG}`)).json()) as {
    calendarEventId: string | null;
  };
  return gig.calendarEventId;
}

beforeAll(async () => {
  await applyMigrations(env.DB);
  await seedUser(env.DB, U1);
  await api(U1, "PUT", `/api/clients/${ACME}`, { name: "Acme" });
});

describe("syncUserGigs", () => {
  it("creates an event for a confirmed dated gig and stores the id", async () => {
    await api(U1, "PUT", `/api/gigs/${GIG}`, {
      clientId: ACME,
      status: "confirmed",
      location: "Costco on 5th",
      dateTime: WHEN,
    });

    const client = stubClient();
    const result = await syncUserGigs(env.DB, U1, client, Date.now());

    expect(result.created).toBe(1);
    expect(client.calls[0]?.op).toBe("create");
    expect(client.calls[0]?.event?.summary).toBe("Acme — Costco on 5th");
    expect(client.calls[0]?.event?.startMs).toBe(WHEN);
    expect(client.calls[0]?.event?.endMs).toBe(WHEN + FOUR_H);
    expect(await gigEventId()).toBe("evt-1");

    // Watermark advanced: a second run does nothing.
    const client2 = stubClient();
    await syncUserGigs(env.DB, U1, client2, Date.now());
    expect(client2.calls).toEqual([]);
  });

  it("patches the event when the gig changes after the watermark", async () => {
    await api(U1, "PUT", `/api/gigs/${GIG}`, {
      clientId: ACME,
      status: "confirmed",
      location: "Costco on 5th",
      dateTime: WHEN,
    });
    const client = stubClient();
    await syncUserGigs(env.DB, U1, client, Date.now());

    await api(U1, "PUT", `/api/gigs/${GIG}`, {
      clientId: ACME,
      status: "confirmed",
      location: "Moved to booth 12",
      dateTime: WHEN + FOUR_H,
    });
    const client2 = stubClient();
    const result = await syncUserGigs(env.DB, U1, client2, Date.now());

    expect(result.updated).toBe(1);
    expect(client2.calls[0]?.op).toBe("patch");
    expect(client2.calls[0]?.eventId).toBe("evt-1");
    expect(client2.calls[0]?.event?.summary).toContain("Moved to booth 12");
  });

  it("demotion to lead deletes the event and clears the id", async () => {
    await api(U1, "PUT", `/api/gigs/${GIG}`, {
      status: "confirmed",
      dateTime: WHEN,
    });
    await syncUserGigs(env.DB, U1, stubClient(), Date.now());
    expect(await gigEventId()).toBe("evt-1");

    await api(U1, "PUT", `/api/gigs/${GIG}`, { status: "lead", dateTime: WHEN });
    const client = stubClient();
    const result = await syncUserGigs(env.DB, U1, client, Date.now());

    expect(result.deleted).toBe(1);
    expect(client.calls).toEqual([{ op: "delete", eventId: "evt-1" }]);
    expect(await gigEventId()).toBeNull();
  });

  it("completed gigs keep their event untouched (history stays)", async () => {
    await api(U1, "PUT", `/api/gigs/${GIG}`, {
      status: "confirmed",
      dateTime: WHEN,
    });
    await syncUserGigs(env.DB, U1, stubClient(), Date.now());

    await api(U1, "PUT", `/api/gigs/${GIG}`, {
      status: "completed",
      dateTime: WHEN,
    });
    const client = stubClient();
    await syncUserGigs(env.DB, U1, client, Date.now());

    expect(client.calls).toEqual([]);
    expect(await gigEventId()).toBe("evt-1");
  });

  it("a confirmed gig whose date was removed loses its event", async () => {
    await api(U1, "PUT", `/api/gigs/${GIG}`, {
      status: "confirmed",
      dateTime: WHEN,
    });
    await syncUserGigs(env.DB, U1, stubClient(), Date.now());

    await api(U1, "PUT", `/api/gigs/${GIG}`, { status: "confirmed" });
    const client = stubClient();
    await syncUserGigs(env.DB, U1, client, Date.now());

    expect(client.calls).toEqual([{ op: "delete", eventId: "evt-1" }]);
    expect(await gigEventId()).toBeNull();
  });

  it("dateless or lead gigs never create events", async () => {
    await api(U1, "PUT", `/api/gigs/${GIG}`, { status: "confirmed" });
    const client = stubClient();
    await syncUserGigs(env.DB, U1, client, Date.now());
    expect(client.calls).toEqual([]);

    await api(U1, "PUT", `/api/gigs/${GIG}`, { status: "lead", dateTime: WHEN });
    const client2 = stubClient();
    await syncUserGigs(env.DB, U1, client2, Date.now());
    expect(client2.calls).toEqual([]);
  });

  it("does not advance the watermark when an operation fails", async () => {
    await api(U1, "PUT", `/api/gigs/${GIG}`, {
      status: "confirmed",
      dateTime: WHEN,
    });

    const failing = stubClient(true);
    const result = await syncUserGigs(env.DB, U1, failing, Date.now());
    expect(result.failed).toBe(1);
    expect(await gigEventId()).toBeNull();

    // Next run retries the same gig.
    const client = stubClient();
    await syncUserGigs(env.DB, U1, client, Date.now());
    expect(client.calls[0]?.op).toBe("create");
    expect(await gigEventId()).toBe("evt-1");
  });

  it("tracks lastSyncAt on the user for the status endpoint", async () => {
    const now = Date.now();
    await syncUserGigs(env.DB, U1, stubClient(), now);
    const user = await UsersRepo.for(env.DB).get(U1);
    expect(user?.lastCalendarSyncAt).toBe(now);
  });
});

// ── deleted-gig cleanup queue (Phase 8 hardening) ─────────────────
// A deleted gig's event id survives in calendar_cleanup; the sync run
// is what actually removes it from Google.
describe("syncUserGigs — cleanup queue", () => {
  const ORPHAN = "77777777-dddd-4ddd-8ddd-777777777777";

  beforeEach(async () => {
    for (const row of await CalendarCleanupRepo.for(env.DB).listPending(U1)) {
      await CalendarCleanupRepo.for(env.DB).remove(U1, row.id);
    }
  });

  it("deletes a queued event and clears the row", async () => {
    const cleanup = CalendarCleanupRepo.for(env.DB);
    await cleanup.enqueue(U1, "evt-orphaned", Date.now());

    const client = stubClient();
    const result = await syncUserGigs(env.DB, U1, client, Date.now());

    expect(client.calls).toContainEqual({ op: "delete", eventId: "evt-orphaned" });
    expect(result.cleaned).toBe(1);
    expect(await cleanup.listPending(U1)).toHaveLength(0);
  });

  it("leaves the row queued when the delete fails, so it retries", async () => {
    const cleanup = CalendarCleanupRepo.for(env.DB);
    await cleanup.enqueue(U1, "evt-unreachable", Date.now());

    const client = { ...stubClient(), deleteEvent: async () => false };
    const result = await syncUserGigs(env.DB, U1, client, Date.now());

    expect(result.cleaned).toBe(0);
    expect(await cleanup.listPending(U1)).toHaveLength(1);
  });

  // The cleanup queue is its own retry mechanism; stalling the gig
  // watermark behind one unreachable event would block gig syncing.
  it("does not hold back the gig watermark when a cleanup fails", async () => {
    await CalendarCleanupRepo.for(env.DB).enqueue(U1, "evt-stuck", Date.now());
    const now = Date.now();

    const client = { ...stubClient(), deleteEvent: async () => false };
    await syncUserGigs(env.DB, U1, client, now);

    const user = await UsersRepo.for(env.DB).get(U1);
    expect(user?.lastCalendarSyncAt).toBe(now);
  });

  it("clears the queue end-to-end when a synced gig is deleted", async () => {
    await api(U1, "PUT", `/api/gigs/${ORPHAN}`, {
      status: "confirmed",
      dateTime: WHEN,
    });
    // First run gives it an event.
    const client = stubClient();
    await syncUserGigs(env.DB, U1, client, Date.now());

    await api(U1, "DELETE", `/api/gigs/${ORPHAN}`);

    const second = stubClient();
    const result = await syncUserGigs(env.DB, U1, second, Date.now());

    expect(result.cleaned).toBe(1);
    expect(second.calls.some((c) => c.op === "delete")).toBe(true);
    expect(await CalendarCleanupRepo.for(env.DB).listPending(U1)).toHaveLength(0);
  });
});

// Phase 9: the event stops being a guess when the gig knows how long
// it runs. The 4h fallback stays for gigs that don't.
describe("syncUserGigs — event duration", () => {
  const TIMED = "88888888-eeee-4eee-8eee-888888888888";

  it("spans the gig's own duration when it has one", async () => {
    await api(U1, "PUT", `/api/gigs/${TIMED}`, {
      status: "confirmed",
      dateTime: WHEN,
      durationMinutes: 90,
    });

    const client = stubClient();
    await syncUserGigs(env.DB, U1, client, Date.now());

    const created = client.calls.find((c) => c.op === "create");
    expect(created?.event?.endMs).toBe(WHEN + 90 * 60 * 1000);
  });

  it("falls back to four hours when the gig has no duration", async () => {
    const NODUR = "89999999-eeee-4eee-8eee-899999999999";
    await api(U1, "PUT", `/api/gigs/${NODUR}`, {
      status: "confirmed",
      dateTime: WHEN,
    });

    const client = stubClient();
    await syncUserGigs(env.DB, U1, client, Date.now());

    const created = client.calls.find((c) => c.op === "create");
    expect(created?.event?.endMs).toBe(WHEN + FOUR_H);
  });
});
