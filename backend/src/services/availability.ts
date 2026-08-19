/**
 * Assembling the public availability answer (Phase 12, Task 2).
 *
 * This module is where the phase's one rule is enforced:
 *
 *   Nothing identifying leaves the boundary.
 *
 * It takes a user id and returns free ranges, a display name the user
 * chose, and a timezone. There is no gig id, no client, no location,
 * no amount, and no count of how busy anyone is beyond the shape of
 * the free time itself. The response type below is the whole contract
 * — if a field is not on it, it cannot be served.
 *
 * The response contains FREE ranges, never busy ones. "Busy 14:00-18:00"
 * is one join away from a competitor knowing a schedule; "free
 * 09:00-14:00" is an answer to the question that was asked.
 */
import { availableSlots, type Range } from "../domain/availability.ts";
import { gigOccupies } from "../domain/gig-time.ts";
import { localClock } from "../domain/timezone.ts";
import type { GigStatus } from "../db/schema.ts";
import type { FreeBusyResult } from "../calendar/google-calendar.ts";
import { GigsRepo } from "../repos/gigs.ts";
import { UsersRepo } from "../repos/users.ts";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/**
 * Offers start on the quarter hour.
 *
 * Clamping to the exact instant of the request produces "free from
 * 15:59", which is not something anyone sends an agency. Rounding UP
 * is the only safe direction: it narrows the claim by a few minutes
 * rather than offering time that has already gone.
 */
const SLOT_GRANULARITY_MS = 15 * MINUTE_MS;

/** Minutes from local midnight to the end of the same local day. */
const END_OF_DAY_MINUTE = 24 * 60;

/**
 * What counts as booked.
 *
 * Leads never block: the whole point of a lead is that it is not yet a
 * commitment, and blocking on one would have the user turning down
 * work for a job they have not been given. `completed` blocks for its
 * historic slot, which matters only if someone asks about the past. A
 * `cancelled` gig fell through — it occupies nothing, past or future.
 */
export const BUSY_STATUSES: readonly GigStatus[] = ["confirmed", "completed"];

/**
 * Everything the public page is allowed to know.
 *
 * `generatedAt` and `horizonEndsAt` are here so the page can say what
 * it is and what window it covers ("as of the 10th, next four weeks").
 * Neither identifies anyone: one is the clock, the other is a setting
 * the user chose and is already implied by the last slot.
 */
export interface PublicAvailability {
  /** null when the user shared hours without sharing who they are. */
  displayName: string | null;
  timeZone: string;
  generatedAt: number;
  horizonEndsAt: number;
  slots: Range[];
  /**
   * What the free time was actually computed from.
   *
   * `"gigs"` means the user's own calendar was not read — switched
   * off, scope declined, or Google unreachable — and the page must say
   * so rather than imply completeness. Silently offering slots the
   * user cannot work is the one outcome worse than no page at all, and
   * this field is what lets the page be honest about which it is.
   *
   * It reveals that a calendar is or is not connected, and nothing
   * about what is on it.
   */
  basedOn: "gigs" | "gigs-and-calendar";
}

/**
 * Reads when the user is busy according to Google, for a window.
 *
 * Injected rather than called directly so the degrade paths — which
 * are most of the risk here — are testable without a network.
 */
export type CalendarBusyReader = (
  userId: string,
  timeMinMs: number,
  timeMaxMs: number,
) => Promise<FreeBusyResult>;

export interface AvailabilityDeps {
  readCalendarBusy?: CalendarBusyReader;
}

/**
 * Free time for a user, ready to serve.
 *
 * `now` is a parameter rather than a call to Date.now() so the whole
 * projection is testable at a fixed instant — including across the two
 * days a year the user's zone shifts.
 */
export async function buildPublicAvailability(
  d1: D1Database,
  userId: string,
  now: number,
  deps: AvailabilityDeps = {},
): Promise<PublicAvailability> {
  const settings = await UsersRepo.for(d1).getSettings(userId);
  const clock = localClock(settings.availabilityTimeZone);

  // The window the page actually describes, rounded at both ends so it
  // reads like something a person wrote. "Free 15:59–17:00, through
  // 15:59 on the 17th" is arithmetically right and looks broken.
  const startAt = Math.ceil(now / SLOT_GRANULARITY_MS) * SLOT_GRANULARITY_MS;
  // "Four weeks" means four whole days-worth of weeks to a reader, so
  // the horizon runs to the end of the local day it lands in. The -1ms
  // keeps a horizon that falls exactly on midnight from gaining a day.
  const horizonEndsAt = clock.localMinuteAt(
    clock.localDayAt(startAt + settings.availabilityHorizonWeeks * WEEK_MS - 1)
      .midnightMs,
    END_OF_DAY_MINUTE,
  );
  const horizonMs = Math.max(0, horizonEndsAt - startAt);

  // Times only — the query never selects a name, place or amount, so
  // there is nothing sensitive in this function to leak by accident.
  const gigs = await GigsRepo.for(d1).listBusyBetween(
    userId,
    now,
    horizonEndsAt,
    BUSY_STATUSES,
  );
  const busy = gigs.map(gigOccupies).filter((r): r is Range => r !== null);

  /**
   * The calendar, if the user asked for it and it answered.
   *
   * Three ways to end up on gigs alone, and all of them are honest
   * rather than silent: the setting is off, the scope was declined, or
   * Google could not be reached. None of them may be reported as
   * "gigs-and-calendar", because the difference between "your calendar
   * is clear" and "we could not look" is the whole feature.
   *
   * The ranges are used here and dropped. Nothing personal reaches D1,
   * and no busy range ever reaches the page — only the free time
   * computed from it.
   */
  let basedOn: PublicAvailability["basedOn"] = "gigs";
  if (settings.availabilityUseCalendar && deps.readCalendarBusy !== undefined) {
    const fromCalendar = await deps.readCalendarBusy(userId, now, horizonEndsAt);
    if (fromCalendar !== null && fromCalendar !== "insufficient-scope") {
      busy.push(...fromCalendar.busy);
      basedOn = "gigs-and-calendar";
    }
  }

  const slots = availableSlots(
    busy,
    {
      now: startAt,
      horizonMs,
      workingWeek: settings.availabilityWorkingWeek,
      localDayAt: clock.localDayAt,
      localMinuteAt: clock.localMinuteAt,
      minSlotMs: settings.availabilityMinSlotMinutes * MINUTE_MS,
    },
  );

  return {
    displayName: settings.availabilityDisplayName,
    timeZone: settings.availabilityTimeZone,
    generatedAt: now,
    horizonEndsAt,
    slots,
    basedOn,
  };
}
