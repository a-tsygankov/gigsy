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
import { GigsRepo } from "../repos/gigs.ts";
import { UsersRepo } from "../repos/users.ts";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/**
 * What counts as booked.
 *
 * Leads never block: the whole point of a lead is that it is not yet a
 * commitment, and blocking on one would have the user turning down
 * work for a job they have not been given. `completed` and `paid`
 * block for their historic slot, which matters only if someone asks
 * about the past.
 */
export const BUSY_STATUSES: readonly GigStatus[] = ["confirmed", "completed", "paid"];

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
): Promise<PublicAvailability> {
  const settings = await UsersRepo.for(d1).getSettings(userId);

  const horizonMs = settings.availabilityHorizonWeeks * WEEK_MS;
  const horizonEndsAt = now + horizonMs;

  // Times only — the query never selects a name, place or amount, so
  // there is nothing sensitive in this function to leak by accident.
  const busy = await GigsRepo.for(d1).listBusyBetween(
    userId,
    now,
    horizonEndsAt,
    BUSY_STATUSES,
  );

  const clock = localClock(settings.availabilityTimeZone);
  const slots = availableSlots(
    busy.map(gigOccupies).filter((r): r is Range => r !== null),
    {
      now,
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
  };
}
