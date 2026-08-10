/**
 * User settings (docs/plan.md §13, Phase 11).
 *
 * One JSON blob on `users`, not a column per setting and not a table.
 * Settings keep arriving; a blob with a schema and defaults means adding
 * one is a code change rather than a migration.
 *
 * The invariant that makes that safe: every read goes through
 * `parseSettings`, which fills defaults for anything absent. A row
 * written by an older version is therefore always valid, and a blob
 * corrupted beyond parsing degrades to defaults rather than failing the
 * request — settings are preferences, and losing one is not worth
 * refusing to load someone's gigs over.
 *
 * Deliberately NOT here: the theme. It belongs to the device and its
 * surroundings — dark on a phone at a night shift, light on a laptop in
 * daylight — so it lives in localStorage. Syncing it would work against
 * the user.
 */
import { z } from "zod";

/** Minutes before a gig that its calendar reminder fires. */
const REMINDER_MIN = 0;
const REMINDER_MAX = 40320; // four weeks; beyond this Google rejects it.

export const SettingsSchema = z.object({
  // --- Calendar ---
  /** Prefix event titles with "Gigsy: " so they're scannable among
   *  personal entries. Off by default: it costs title width on a phone. */
  calendarTitlePrefix: z.boolean().default(false),
  /** Let a user who curates their own calendar defaults opt out of our
   *  reminder entirely, rather than forcing ours on top of theirs. */
  calendarUseDefaultReminder: z.boolean().default(false),
  calendarReminderMinutes: z.number().int().min(REMINDER_MIN).max(REMINDER_MAX).default(60),
  /** Which Google calendar receives events. "primary" is the user's
   *  main one; a dedicated Gigsy calendar stores its id here. */
  calendarTargetId: z.string().min(1).max(200).default("primary"),

  // --- Gigs ---
  /** Prefill new gigs with the usual shift instead of "Not set".
   *  null means no prefill. */
  defaultGigDurationMinutes: z
    .number()
    .int()
    .positive()
    .max(REMINDER_MAX)
    .nullable()
    .default(null),
  /** ISO 4217. `formatMoney` hardcoded USD; a gig tracker that can only
   *  speak dollars is a real limit. */
  currency: z.string().regex(/^[A-Z]{3}$/).default("USD"),

  // --- Notifications ---
  /** Master switch. Off means no nudge is ever sent, whatever the
   *  per-nudge flags say — one obvious way to stop all of it. */
  notificationsEnabled: z.boolean().default(true),
  nudgeStaleLeadsEnabled: z.boolean().default(true),
  nudgeUnpaidEnabled: z.boolean().default(true),
  /** Exactly the sort of number one person finds nagging and another
   *  finds too quiet, which is why they are settings and not constants. */
  nudgeStaleLeadDays: z.number().int().min(1).max(365).default(7),
  nudgeUnpaidDays: z.number().int().min(1).max(365).default(14),
});

export type Settings = z.infer<typeof SettingsSchema>;

/** Every setting, at its default. Parsing an empty object fills them
 *  all, so the defaults are stated once — in the schema above. */
export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({});

/**
 * Settings from whatever is stored, always complete.
 *
 * Accepts null (never saved), a JSON string (the column), or an already
 * parsed object. Anything unreadable — corrupt JSON, a value out of
 * range, a key we retired — yields defaults for the parts that fail
 * rather than throwing.
 */
export function parseSettings(stored: string | null | undefined | unknown): Settings {
  if (stored === null || stored === undefined || stored === "") {
    return { ...DEFAULT_SETTINGS };
  }

  let raw: unknown = stored;
  if (typeof stored === "string") {
    try {
      raw = JSON.parse(stored);
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ...DEFAULT_SETTINGS };
  }

  const parsed = SettingsSchema.safeParse(raw);
  if (parsed.success) return parsed.data;

  // Partial recovery: keep the fields that are valid and default only
  // the ones that aren't. An out-of-range reminder shouldn't silently
  // reset someone's currency too.
  const record = raw as Record<string, unknown>;
  const recovered: Record<string, unknown> = {};
  for (const key of Object.keys(SettingsSchema.shape)) {
    if (!(key in record)) continue;
    const field = SettingsSchema.shape[key as keyof Settings];
    if (field.safeParse(record[key]).success) recovered[key] = record[key];
  }
  return SettingsSchema.parse(recovered);
}

/**
 * A patch as it arrives from the client: every key optional, unknown
 * keys rejected outright rather than stored and silently ignored — a
 * typo that appears to save is worse than one that errors.
 */
export const SettingsPatchSchema = SettingsSchema.partial().strict();
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

/** Apply a patch to stored settings. Merges rather than replaces, so a
 *  client that knows about three settings can't wipe the other nine. */
export function mergeSettings(current: Settings, patch: SettingsPatch): Settings {
  return SettingsSchema.parse({ ...current, ...patch });
}
