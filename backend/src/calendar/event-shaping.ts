/**
 * Which settings change what an event LOOKS like, as opposed to which
 * gigs get one.
 *
 * `syncUserGigs` (sync-service.ts) only reconsiders gigs stored since
 * the user's watermark, and a settings change stores no gig. So a
 * flipped "Prefix event titles" used to rename nothing already on the
 * calendar: every existing event kept its old title until its gig
 * happened to be edited, which from the calendar looked like the
 * setting did not work. Resetting the watermark (the same thing
 * "Re-sync everything" and a reconnect do) makes the next run rewrite
 * every event with the new shape; the settings route does that when
 * one of these keys actually changes value.
 *
 * The reminder settings are here for the same reason: they are written
 * into every event too (buildEvent), and a changed reminder that only
 * reaches new gigs is the same complaint in different words.
 */
import type { Settings } from "../domain/settings.ts";

export const EVENT_SHAPING_SETTINGS = [
  "calendarTitlePrefix",
  "calendarUseDefaultReminder",
  "calendarReminderMinutes",
] as const satisfies readonly (keyof Settings)[];

/** True when any event-shaping setting differs between the two. A
 *  patch that re-sends the stored value is not a change — resetting
 *  the watermark for it would cost a full rewrite for nothing. */
export function eventShapeChanged(before: Settings, after: Settings): boolean {
  return EVENT_SHAPING_SETTINGS.some((key) => before[key] !== after[key]);
}
