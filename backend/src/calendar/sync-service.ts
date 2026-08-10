/**
 * Calendar reconciliation (docs/plan.md §9). Rules, pinned in the
 * phase plan:
 * - only `confirmed` gigs with a date get events; leads never do;
 * - `completed|paid` keep their events untouched (history);
 * - demotion to lead — or a removed date — deletes the event;
 * - the per-user watermark (`last_calendar_sync_at`) only advances
 *   on a fully clean run, so failures retry next time. It is compared
 *   against `server_modified_at`, never `modified_at` — the latter is
 *   the phone's clock, and an offline edit would land below the mark;
 * - events whose gig was deleted are drained from the cleanup queue
 *   first (Phase 8) — the gig row that held the id is already gone,
 *   so the watermark can't find them.
 */
import { CalendarCleanupRepo } from "../repos/calendar-cleanup.ts";
import { ClientsRepo } from "../repos/clients.ts";
import { GigsRepo, type GigRecord } from "../repos/gigs.ts";
import { UsersRepo } from "../repos/users.ts";
import type { CalendarEventInput } from "./google-calendar.ts";
import type { Settings } from "../domain/settings.ts";
import { gigOccupies } from "../domain/gig-time.ts";

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

/** Optional prefix so Gigsy entries are scannable among personal ones.
 *  Off by default: it costs title width on a phone (Phase 11). */
const TITLE_PREFIX = "Gigsy: ";

function buildEvent(
  gig: GigRecord,
  clientNames: Map<string, string>,
  settings: Settings,
): CalendarEventInput {
  const clientName =
    gig.clientId !== null ? clientNames.get(gig.clientId) : undefined;
  const base =
    [clientName, gig.location].filter((p) => p != null && p !== "").join(" — ") ||
    "Gig";
  const summary = settings.calendarTitlePrefix ? `${TITLE_PREFIX}${base}` : base;
  const description = [gig.notes ?? "", "Managed by Gigsy"]
    .filter((p) => p !== "")
    .join("\n\n");
  // Callers only reach here for a gig with a date, so the interval is
  // never null. Shared with the availability projection so the two
  // cannot drift: a gig blocking four hours here must block four
  // hours there (domain/gig-time.ts).
  const occupies = gigOccupies(gig)!;
  return {
    summary,
    description,
    location: gig.location,
    reminderMinutes: settings.calendarUseDefaultReminder
      ? null
      : settings.calendarReminderMinutes,
    startMs: occupies.start,
    endMs: occupies.end,
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

  // Once per run: every gig in this pass shares the same preferences.
  const settings = await usersRepo.getSettings(userId);

  const changed = await gigsRepo.listStoredSince(
    userId,
    user.lastCalendarSyncAt ?? 0,
  );
  const clientNames = new Map(
    (await ClientsRepo.for(d1).list(userId)).map((c) => [c.id, c.name]),
  );

  for (const gig of changed) {
    const wantsEvent = gig.status === "confirmed" && gig.dateTime !== null;

    if (wantsEvent) {
      const event = buildEvent(gig, clientNames, settings);
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
