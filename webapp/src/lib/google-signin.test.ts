import { describe, expect, it } from "vitest";
import {
  CALENDAR_APP_CREATED_SCOPE,
  CALENDAR_EVENTS_SCOPE,
  CALENDAR_FREEBUSY_SCOPE,
} from "./google-signin.ts";

/**
 * These assert the literal scope strings, which is unusual and
 * deliberate: a scope is not an implementation detail the way a
 * constant's value usually is. It is what a consent screen shows the
 * user, what Google reviews the app against, and what
 * `docs/google-oauth-verification.md` states in writing. Widening one
 * by a typo — `calendar.readonly` for `calendar.freebusy` — is a
 * privacy regression that nothing else in the suite would notice,
 * because both permit the one call the app makes.
 */
describe("calendar scopes", () => {
  it("reads availability with freebusy, never the far broader readonly", () => {
    expect(CALENDAR_FREEBUSY_SCOPE).toBe(
      "https://www.googleapis.com/auth/calendar.freebusy",
    );
    // `calendar.readonly` grants every event title, description,
    // location and guest list. Gigsy calls only `POST /freeBusy`,
    // which returns busy ranges and no event content at all.
    expect(CALENDAR_FREEBUSY_SCOPE).not.toContain("readonly");
  });

  it("creates the dedicated calendar with app.created, not the full calendar scope", () => {
    expect(CALENDAR_APP_CREATED_SCOPE).toBe(
      "https://www.googleapis.com/auth/calendar.app.created",
    );
  });

  it("keeps events as its own scope — app.created cannot write to primary", () => {
    expect(CALENDAR_EVENTS_SCOPE).toBe(
      "https://www.googleapis.com/auth/calendar.events",
    );
    expect(CALENDAR_EVENTS_SCOPE).not.toBe(CALENDAR_APP_CREATED_SCOPE);
  });
});
