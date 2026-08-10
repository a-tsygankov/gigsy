/// <reference types="@cloudflare/vitest-pool-workers" />
/**
 * The settings blob's contract (Phase 11, Task 1).
 *
 * These are the guarantees that make a JSON column safe to keep adding
 * to: a row written by an older version still reads, a partial patch
 * can't wipe what it doesn't mention, and nothing a client sends can
 * make settings unreadable.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_SETTINGS,
  SettingsPatchSchema,
  mergeSettings,
  parseSettings,
} from "../src/domain/settings.ts";

describe("parseSettings", () => {
  it("returns defaults for a user who has never saved", () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings("")).toEqual(DEFAULT_SETTINGS);
  });

  it("states the defaults the rest of the app relies on", () => {
    // Pinned deliberately: the calendar sync and push cron read these,
    // so a casual change to one is a behaviour change for every user.
    expect(DEFAULT_SETTINGS).toEqual({
      calendarTitlePrefix: false,
      calendarUseDefaultReminder: false,
      calendarReminderMinutes: 60,
      calendarTargetId: "primary",
      defaultGigDurationMinutes: null,
      currency: "USD",
      notificationsEnabled: true,
      nudgeStaleLeadsEnabled: true,
      nudgeUnpaidEnabled: true,
      nudgeStaleLeadDays: 7,
      nudgeUnpaidDays: 14,
      availabilityDisplayName: null,
      availabilityTimeZone: "UTC",
      availabilityWorkingWeek: [
        null,
        { startMinute: 540, endMinute: 1020 },
        { startMinute: 540, endMinute: 1020 },
        { startMinute: 540, endMinute: 1020 },
        { startMinute: 540, endMinute: 1020 },
        { startMinute: 540, endMinute: 1020 },
        null,
      ],
      availabilityHorizonWeeks: 4,
      availabilityMinSlotMinutes: 60,
      // Off until the user knowingly grants the wider scope. Reading
      // someone's calendar is not a default.
      availabilityUseCalendar: false,
    });
  });

  it("fills defaults for settings a stored row predates", () => {
    // Exactly what an older version's row looks like after new settings
    // ship: some keys present, the rest simply absent.
    const stored = JSON.stringify({ currency: "EUR", nudgeUnpaidDays: 30 });

    const settings = parseSettings(stored);

    expect(settings.currency).toBe("EUR");
    expect(settings.nudgeUnpaidDays).toBe(30);
    expect(settings.calendarReminderMinutes).toBe(60);
    expect(settings.calendarTargetId).toBe("primary");
  });

  it("falls back to defaults rather than throwing on an unparseable blob", () => {
    // Losing a preference is not worth refusing to load someone's gigs.
    expect(parseSettings("{not json at all")).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings("[1,2,3]")).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('"a string"')).toEqual(DEFAULT_SETTINGS);
  });

  it("defaults only the invalid fields, keeping the valid ones", () => {
    const stored = JSON.stringify({
      currency: "EUR",
      calendarReminderMinutes: -5, // out of range
      nudgeStaleLeadDays: 999_999, // out of range
    });

    const settings = parseSettings(stored);

    // An out-of-range reminder must not silently reset the currency too.
    expect(settings.currency).toBe("EUR");
    expect(settings.calendarReminderMinutes).toBe(60);
    expect(settings.nudgeStaleLeadDays).toBe(7);
  });

  it("ignores keys that no longer exist", () => {
    const stored = JSON.stringify({ currency: "GBP", retiredSetting: true });

    const settings = parseSettings(stored);

    expect(settings.currency).toBe("GBP");
    expect(settings).not.toHaveProperty("retiredSetting");
  });
});

describe("SettingsPatchSchema", () => {
  it("accepts a patch naming only some settings", () => {
    const result = SettingsPatchSchema.safeParse({ currency: "CAD" });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown key instead of storing it", () => {
    // A typo that appears to save is worse than one that errors.
    const result = SettingsPatchSchema.safeParse({ curency: "CAD" });
    expect(result.success).toBe(false);
  });

  it("rejects a value outside its range", () => {
    expect(SettingsPatchSchema.safeParse({ nudgeUnpaidDays: 0 }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ currency: "dollars" }).success).toBe(false);
    expect(
      SettingsPatchSchema.safeParse({ defaultGigDurationMinutes: 0 }).success,
    ).toBe(false);
  });

  it("allows clearing the optional duration with null", () => {
    const result = SettingsPatchSchema.safeParse({ defaultGigDurationMinutes: null });
    expect(result.success).toBe(true);
  });
});

/**
 * The availability settings (Phase 12). Held to a tighter standard
 * than the rest of the blob for one reason: these are the only
 * settings that shape what an unauthenticated stranger sees, and a
 * value that survives validation here is a value the public endpoint
 * will act on.
 */
describe("availability settings", () => {
  const day = { startMinute: 540, endMinute: 1020 };
  const week = [null, day, day, day, day, day, null];

  it("accepts a working week and a real zone", () => {
    const result = SettingsPatchSchema.safeParse({
      availabilityTimeZone: "America/New_York",
      availabilityWorkingWeek: week,
      availabilityDisplayName: "Andrey",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a timezone Intl cannot resolve", () => {
    // Unchecked, this reaches Intl inside a public request and throws.
    expect(
      SettingsPatchSchema.safeParse({ availabilityTimeZone: "Mars/Olympus_Mons" }).success,
    ).toBe(false);
  });

  it("rejects a week that is not exactly seven days", () => {
    // The projection indexes this by Date#getDay; a short array would
    // silently read as "day off" for the missing days.
    expect(
      SettingsPatchSchema.safeParse({ availabilityWorkingWeek: [null, day] }).success,
    ).toBe(false);
    expect(
      SettingsPatchSchema.safeParse({
        availabilityWorkingWeek: [...week, day],
      }).success,
    ).toBe(false);
  });

  it("rejects a day whose end is not after its start", () => {
    const inverted = [null, { startMinute: 1020, endMinute: 540 }, null, null, null, null, null];
    expect(
      SettingsPatchSchema.safeParse({ availabilityWorkingWeek: inverted }).success,
    ).toBe(false);

    const empty = [null, { startMinute: 540, endMinute: 540 }, null, null, null, null, null];
    expect(
      SettingsPatchSchema.safeParse({ availabilityWorkingWeek: empty }).success,
    ).toBe(false);
  });

  it("rejects minutes outside a day", () => {
    const late = [null, { startMinute: 540, endMinute: 1441 }, null, null, null, null, null];
    expect(SettingsPatchSchema.safeParse({ availabilityWorkingWeek: late }).success).toBe(
      false,
    );
  });

  it("allows a shift that ends at 24:00", () => {
    // 1440 is the end of the day, and the projection resolves it to the
    // next midnight rather than inverting the window.
    const late = [null, { startMinute: 1080, endMinute: 1440 }, null, null, null, null, null];
    expect(SettingsPatchSchema.safeParse({ availabilityWorkingWeek: late }).success).toBe(
      true,
    );
  });

  it("bounds the horizon", () => {
    // An infinite calendar invites scraping and answers a question
    // nobody asked.
    expect(SettingsPatchSchema.safeParse({ availabilityHorizonWeeks: 0 }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ availabilityHorizonWeeks: 53 }).success).toBe(
      false,
    );
    expect(SettingsPatchSchema.safeParse({ availabilityHorizonWeeks: 12 }).success).toBe(true);
  });

  it("clears the display name with null", () => {
    expect(
      SettingsPatchSchema.safeParse({ availabilityDisplayName: null }).success,
    ).toBe(true);
  });

  it("refuses a display name long enough to be a message", () => {
    // The name is echoed verbatim to strangers; it is a label, not a
    // free-text channel.
    expect(
      SettingsPatchSchema.safeParse({ availabilityDisplayName: "x".repeat(200) }).success,
    ).toBe(false);
  });

  it("keeps a valid week when some other setting is corrupt", () => {
    const stored = JSON.stringify({
      availabilityWorkingWeek: week,
      availabilityHorizonWeeks: 999,
    });

    const settings = parseSettings(stored);

    expect(settings.availabilityWorkingWeek).toEqual(week);
    expect(settings.availabilityHorizonWeeks).toBe(4);
  });
});

describe("mergeSettings", () => {
  it("merges rather than replaces", () => {
    const current = { ...DEFAULT_SETTINGS, currency: "EUR", nudgeUnpaidDays: 21 };

    const merged = mergeSettings(current, { calendarTitlePrefix: true });

    // A client that knows about three settings must not wipe the rest.
    expect(merged.calendarTitlePrefix).toBe(true);
    expect(merged.currency).toBe("EUR");
    expect(merged.nudgeUnpaidDays).toBe(21);
  });

  it("overwrites the settings the patch does name", () => {
    const current = { ...DEFAULT_SETTINGS, currency: "EUR" };

    const merged = mergeSettings(current, { currency: "JPY" });

    expect(merged.currency).toBe("JPY");
  });
});
