/**
 * The settings the server owns, mirrored for the client (Phase 11).
 *
 * Deliberately a hand-kept mirror of backend/src/domain/settings.ts
 * rather than a shared package: the two halves have no build-time link,
 * and the server is the authority — it fills defaults on every read and
 * rejects anything it does not recognise, so a client that drifts gets
 * a 400 rather than silently corrupting a blob.
 *
 * The theme is NOT here. It belongs to the device and its surroundings,
 * not the person, so it lives in localStorage.
 */
export interface Settings {
  calendarTitlePrefix: boolean;
  calendarUseDefaultReminder: boolean;
  calendarReminderMinutes: number;
  calendarTargetId: string;
  defaultGigDurationMinutes: number | null;
  currency: string;
  notificationsEnabled: boolean;
  nudgeStaleLeadsEnabled: boolean;
  nudgeUnpaidEnabled: boolean;
  nudgeStaleLeadDays: number;
  nudgeUnpaidDays: number;

  // Availability (Phase 12). The only settings that shape what an
  // unauthenticated stranger sees, so the Settings screen has to be
  // explicit about what each one exposes.
  availabilityDisplayName: string | null;
  /** IANA zone the working week is expressed in. */
  availabilityTimeZone: string;
  /** Sunday first, matching Date#getDay. null is a day off — not zero
   *  hours, which reads as a bug where "closed" reads as a decision. */
  availabilityWorkingWeek: ({ startMinute: number; endMinute: number } | null)[];
  availabilityHorizonWeeks: number;
  availabilityMinSlotMinutes: number;
  /** Read the user's Google Calendar too. Off unless they granted the
   *  wider scope knowingly; the page says which basis it used. */
  availabilityUseCalendar: boolean;
}

export type SettingsPatch = Partial<Settings>;
