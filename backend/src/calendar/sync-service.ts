/**
 * Calendar reconciliation (docs/plan.md §9). Rules, pinned in the
 * phase plan:
 * - only `confirmed` gigs with a date get events; leads never do;
 * - `completed|paid` keep their events untouched (history);
 * - demotion to lead — or a removed date — deletes the event;
 * - the per-user watermark (`last_calendar_sync_at`) only advances
 *   on a fully clean run, so failures retry next time;
 * - events whose gig was deleted are drained from the cleanup queue
 *   first (Phase 8) — the gig row that held the id is already gone,
 *   so the watermark can't find them.
 */
import { CalendarCleanupRepo } from "../repos/calendar-cleanup.ts";
import { ClientsRepo } from "../repos/clients.ts";
import { GigsRepo, type GigRecord } from "../repos/gigs.ts";
import { UsersRepo } from "../repos/users.ts";
import type { CalendarEventInput } from "./google-calendar.ts";

// Used only when a gig has no duration of its own (Phase 9 added the
// field; everything created before it, and anything the user leaves
// blank, still needs an end time for the calendar).
const DEFAULT_DURATION_MS = 4 * 60 * 60 * 1000;

export interface CalendarClientLike {
  createEvent(event: CalendarEventInput): Promise<string | null>;
  patchEvent(eventId: string, event: CalendarEventInput): Promise<boolean>;
  deleteEvent(eventId: string): Promise<boolean>;
}

export interface CalendarSyncResult {
  created: number;
  updated: number;
  deleted: number;
  failed: number;
  /** Orphaned events removed from the deleted-gig queue. Counted
   * apart from `failed` so a stuck cleanup never stalls the gig
   * watermark — the queued row is its own retry. */
  cleaned: number;
}

function buildEvent(
  gig: GigRecord,
  clientNames: Map<string, string>,
): CalendarEventInput {
  const clientName =
    gig.clientId !== null ? clientNames.get(gig.clientId) : undefined;
  const summary =
    [clientName, gig.location].filter((p) => p != null && p !== "").join(" — ") ||
    "Gig";
  const description = [gig.notes ?? "", "Managed by Gigsy"]
    .filter((p) => p !== "")
    .join("\n\n");
  return {
    summary,
    description,
    startMs: gig.dateTime!,
    endMs:
      gig.dateTime! +
      (gig.durationMinutes !== null
        ? gig.durationMinutes * 60 * 1000
        : DEFAULT_DURATION_MS),
  };
}

export async function syncUserGigs(
  d1: D1Database,
  userId: string,
  client: CalendarClientLike,
  now: number,
): Promise<CalendarSyncResult> {
  const result: CalendarSyncResult = {
    created: 0,
    updated: 0,
    deleted: 0,
    failed: 0,
    cleaned: 0,
  };
  const usersRepo = UsersRepo.for(d1);
  const gigsRepo = GigsRepo.for(d1);

  const user = await usersRepo.get(userId);
  if (user === null) return result;

  // Deleted gigs first: their event ids only exist in the queue now.
  const cleanupRepo = CalendarCleanupRepo.for(d1);
  for (const row of await cleanupRepo.listPending(userId)) {
    // A 404/410 counts as deleted in CalendarClient, so an event the
    // user removed by hand drains cleanly too.
    if (await client.deleteEvent(row.calendarEventId)) {
      await cleanupRepo.remove(userId, row.id);
      result.cleaned++;
    }
  }

  const changed = await gigsRepo.listModifiedSince(
    userId,
    user.lastCalendarSyncAt ?? 0,
  );
  const clientNames = new Map(
    (await ClientsRepo.for(d1).list(userId)).map((c) => [c.id, c.name]),
  );

  for (const gig of changed) {
    const wantsEvent = gig.status === "confirmed" && gig.dateTime !== null;

    if (wantsEvent) {
      const event = buildEvent(gig, clientNames);
      if (gig.calendarEventId === null) {
        const eventId = await client.createEvent(event);
        if (eventId === null) {
          result.failed++;
          continue;
        }
        await gigsRepo.setCalendarEventId(userId, gig.id, eventId);
        result.created++;
      } else if (await client.patchEvent(gig.calendarEventId, event)) {
        result.updated++;
      } else {
        result.failed++;
      }
      continue;
    }

    // No event wanted: delete only for demotions/date-removal —
    // completed|paid history keeps its events.
    const shouldDelete =
      gig.calendarEventId !== null &&
      (gig.status === "lead" ||
        (gig.status === "confirmed" && gig.dateTime === null));
    if (shouldDelete) {
      if (await client.deleteEvent(gig.calendarEventId!)) {
        await gigsRepo.setCalendarEventId(userId, gig.id, null);
        result.deleted++;
      } else {
        result.failed++;
      }
    }
  }

  if (result.failed === 0) {
    await usersRepo.setLastCalendarSyncAt(userId, now);
  }
  return result;
}
