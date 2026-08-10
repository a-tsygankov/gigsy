/// <reference types="@cloudflare/vitest-pool-workers" />
/**
 * Availability with the user's own calendar folded in (Phase 12, Task 3).
 *
 * Gigsy knows about gigs. It does not know about the dentist, the
 * school run, or a gig booked through an agency that never reached the
 * app — so a page built on Gigsy data alone confidently offers slots
 * the user cannot work. That is worse than no page, because the user
 * has now promised something.
 *
 * Reading the calendar fixes it, and introduces a new way to be wrong:
 * a failed read that looks like an empty calendar. Most of this file is
 * about that. The rule throughout is that uncertainty degrades to
 * "gigs only, and say so" — never to "free".
 */
import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations, seedUser } from "./helpers/db.ts";
import {
  buildPublicAvailability,
  type CalendarBusyReader,
} from "../src/services/availability.ts";
import type { FreeBusyResult } from "../src/calendar/google-calendar.ts";

const U1 = "avail-fb-user";
const HOUR = 60 * 60 * 1000;
const NOW = Date.now();

const CAL_START = NOW + 30 * HOUR;
const CAL_END = CAL_START + 2 * HOUR;
const GIG_START = NOW + 54 * HOUR;
const GIG_END = GIG_START + 2 * HOUR;

/** Round the clock for a week, so working hours never mask the point. */
function settingsJson(useCalendar: boolean): string {
  return JSON.stringify({
    availabilityDisplayName: "Andrey",
    availabilityTimeZone: "UTC",
    availabilityWorkingWeek: Array.from({ length: 7 }, () => ({
      startMinute: 0,
      endMinute: 1440,
    })),
    availabilityHorizonWeeks: 1,
    availabilityMinSlotMinutes: 30,
    availabilityUseCalendar: useCalendar,
  });
}

async function setUseCalendar(on: boolean): Promise<void> {
  await env.DB.prepare("UPDATE users SET settings_json = ? WHERE id = ?")
    .bind(settingsJson(on), U1)
    .run();
}

/** A reader that records whether it was consulted at all. */
function reader(result: FreeBusyResult): CalendarBusyReader & { calls: number } {
  const fn = Object.assign(
    async () => {
      fn.calls++;
      return result;
    },
    { calls: 0 },
  );
  return fn as CalendarBusyReader & { calls: number };
}

const overlaps = (
  slots: { start: number; end: number }[],
  range: { start: number; end: number },
): boolean => slots.some((s) => s.start < range.end && s.end > range.start);

beforeAll(async () => {
  await applyMigrations(env.DB);
  await seedUser(env.DB, U1);
  await env.DB.prepare(
    `INSERT INTO gigs (id, user_id, status, date_time, duration_minutes,
       created_at, modified_at, server_modified_at)
     VALUES ('avail-fb-gig', ?, 'confirmed', ?, 120, ?, ?, ?)`,
  )
    .bind(U1, GIG_START, NOW, NOW, NOW)
    .run();
});

describe("buildPublicAvailability with the calendar switched on", () => {
  it("subtracts what the calendar says is busy", async () => {
    await setUseCalendar(true);

    const result = await buildPublicAvailability(env.DB, U1, NOW, {
      readCalendarBusy: reader({ busy: [{ start: CAL_START, end: CAL_END }] }),
    });

    expect(overlaps(result.slots, { start: CAL_START, end: CAL_END })).toBe(false);
  });

  it("still subtracts the gigs", async () => {
    await setUseCalendar(true);

    const result = await buildPublicAvailability(env.DB, U1, NOW, {
      readCalendarBusy: reader({ busy: [{ start: CAL_START, end: CAL_END }] }),
    });

    expect(overlaps(result.slots, { start: GIG_START, end: GIG_END })).toBe(false);
  });

  it("says the answer was built from both", async () => {
    await setUseCalendar(true);

    const result = await buildPublicAvailability(env.DB, U1, NOW, {
      readCalendarBusy: reader({ busy: [] }),
    });

    expect(result.basedOn).toBe("gigs-and-calendar");
  });

  it("serves the free time computed from those ranges, never the ranges", async () => {
    // Honest about the limit of this promise. A free slot that ends
    // where a busy block starts shares that boundary — publishing free
    // time at all makes the gap visible, and no amount of care changes
    // that arithmetic. What is never served is the block itself.
    await setUseCalendar(true);

    const result = await buildPublicAvailability(env.DB, U1, NOW, {
      readCalendarBusy: reader({ busy: [{ start: CAL_START, end: CAL_END }] }),
    });

    expect(result.slots.some((s) => s.start === CAL_START && s.end === CAL_END)).toBe(
      false,
    );
    expect(overlaps(result.slots, { start: CAL_START, end: CAL_END })).toBe(false);
  });

  it("makes a private appointment indistinguishable from a gig", async () => {
    // The promise that actually matters, and the reason the gap being
    // visible is acceptable. A reader can see that the user is
    // unavailable from 14:00 to 16:00. Nothing tells them whether that
    // is a booking, a dentist, or a nap — the two paths produce byte
    // identical slots.
    await setUseCalendar(true);
    const fromCalendar = await buildPublicAvailability(env.DB, U1, NOW, {
      readCalendarBusy: reader({ busy: [{ start: CAL_START, end: CAL_END }] }),
    });

    // The same interval, as a gig this time. Isolated storage rolls
    // this insert back after the test.
    await env.DB.prepare(
      `INSERT INTO gigs (id, user_id, status, date_time, duration_minutes,
         created_at, modified_at, server_modified_at)
       VALUES ('avail-fb-gig-2', ?, 'confirmed', ?, 120, ?, ?, ?)`,
    )
      .bind(U1, CAL_START, NOW, NOW, NOW)
      .run();
    const fromGig = await buildPublicAvailability(env.DB, U1, NOW, {
      readCalendarBusy: reader({ busy: [] }),
    });

    expect(fromGig.slots).toEqual(fromCalendar.slots);
  });
});

describe("buildPublicAvailability when the calendar cannot be read", () => {
  it("falls back to gigs alone, and says so, when the read fails", async () => {
    await setUseCalendar(true);

    const result = await buildPublicAvailability(env.DB, U1, NOW, {
      readCalendarBusy: reader(null),
    });

    expect(result.basedOn).toBe("gigs");
    // The gig is still honoured — degrading is not giving up.
    expect(overlaps(result.slots, { start: GIG_START, end: GIG_END })).toBe(false);
  });

  it("falls back when the scope was never granted", async () => {
    await setUseCalendar(true);

    const result = await buildPublicAvailability(env.DB, U1, NOW, {
      readCalendarBusy: reader("insufficient-scope"),
    });

    expect(result.basedOn).toBe("gigs");
  });

  it("does NOT quietly offer the time it failed to check", async () => {
    // The failure mode worth naming: a null read must not be treated as
    // "nothing on the calendar". It cannot un-book the slot it never
    // saw, but it must not claim the answer includes it either.
    await setUseCalendar(true);

    const failed = await buildPublicAvailability(env.DB, U1, NOW, {
      readCalendarBusy: reader(null),
    });
    const succeeded = await buildPublicAvailability(env.DB, U1, NOW, {
      readCalendarBusy: reader({ busy: [] }),
    });

    // Identical slots, different claims about what was checked.
    expect(failed.slots).toEqual(succeeded.slots);
    expect(failed.basedOn).not.toBe(succeeded.basedOn);
  });
});

describe("buildPublicAvailability with the calendar switched off", () => {
  it("never touches the calendar", async () => {
    // Off means off: no token minted, no request to Google, nothing.
    await setUseCalendar(false);
    const never = reader({ busy: [{ start: CAL_START, end: CAL_END }] });

    const result = await buildPublicAvailability(env.DB, U1, NOW, {
      readCalendarBusy: never,
    });

    expect(never.calls).toBe(0);
    expect(result.basedOn).toBe("gigs");
    expect(overlaps(result.slots, { start: CAL_START, end: CAL_END })).toBe(true);
  });

  it("says gigs when no reader was supplied at all", async () => {
    await setUseCalendar(true);

    const result = await buildPublicAvailability(env.DB, U1, NOW);

    expect(result.basedOn).toBe("gigs");
  });
});
