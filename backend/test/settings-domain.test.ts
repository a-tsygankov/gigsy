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
