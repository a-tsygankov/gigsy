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
import type { GigSort } from "./gig-filters.ts";
import type { GigStatus } from "./types.ts";

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

  /** How the user last left the gig list. The search text is
   *  deliberately not among them — see gig-filters.ts. */
  gigListStatuses: GigStatus[];
  gigListSort: GigSort;
  gigListHidePast: boolean;
  gigListClientId: string | null;
  /** Epoch ms, stored absolute. Read back through
   *  `filtersFromSettings`, which drops a range that has fully passed. */
  gigListFrom: number | null;
  gigListTo: number | null;

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

  // --- Invoicing ---
  // Mirrors backend/src/domain/settings.ts. The server bounds these;
  // this side only needs their shape.
  businessName: string | null;
  businessAddress: string | null;
  businessContact: string | null;
  businessTaxId: string | null;
  businessPaymentDetails: string | null;
  /** The number the NEXT invoice will carry. */
  invoiceNextNumber: number;
  invoicePaymentTermsDays: number;
}

export type SettingsPatch = Partial<Settings>;
