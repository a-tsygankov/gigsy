import { describe, expect, it } from "vitest";
import { gigToInput } from "./gig-input.ts";
import type { Gig } from "./types.ts";

const GIG: Gig = {
  id: "g1",
  clientId: "c1",
  title: "Costco tasting",
  status: "confirmed",
  location: "Costco on 5th",
  dateTime: 1_800_000_000_000,
  durationMinutes: 240,
  payType: "hourly",
  hourlyRateCents: 5000,
  workStartedAt: 1_800_000_060_000,
  workEndedAt: 1_800_010_000_000,
  breakMinutes: 18,
  calendarEventId: "evt-1",
  amountOfferedCents: 18917,
  amountPaidCents: 5000,
  expectedCents: 15000,
  notes: "Booth 12",
  source: "email",
  createdAt: 1,
  modifiedAt: 2,
};

describe("gigToInput", () => {
  it("carries every writable field through unchanged", () => {
    expect(gigToInput(GIG)).toEqual({
      clientId: "c1",
      title: "Costco tasting",
      status: "confirmed",
      location: "Costco on 5th",
      dateTime: 1_800_000_000_000,
      durationMinutes: 240,
      payType: "hourly",
      hourlyRateCents: 5000,
      workStartedAt: 1_800_000_060_000,
      workEndedAt: 1_800_010_000_000,
      breakMinutes: 18,
      amountOfferedCents: 18917,
      amountPaidCents: 5000,
      notes: "Booth 12",
    });
  });

  it("keeps nulls as nulls rather than dropping the keys", () => {
    // A dropped key and a null read the same to `putGig` — both store
    // null — but they do NOT read the same to a caller spreading a patch
    // over this object, which is the whole use.
    const blank = gigToInput({ ...GIG, location: null, workEndedAt: null });
    expect("location" in blank).toBe(true);
    expect(blank.location).toBeNull();
    expect(blank.workEndedAt).toBeNull();
  });

  it("omits the server-owned expected figure", () => {
    // Sending it would be ignored at best; the outbox is the one thing
    // an offline client can push, so this stays deliberate.
    expect("expectedCents" in gigToInput(GIG)).toBe(false);
  });

  it("carries the plan through a work patch untouched", () => {
    // The assertion the whole phase turns on. This is how every Work
    // card write is built — one field over the whole gig — and the
    // fault it exists to prevent is a work control moving `dateTime`
    // or `durationMinutes`, which are what the calendar event and the
    // availability projection are made of.
    const patched = { ...gigToInput(GIG), workEndedAt: 1_800_020_000_000 };
    expect(patched.dateTime).toBe(GIG.dateTime);
    expect(patched.durationMinutes).toBe(GIG.durationMinutes);
    expect(patched.workEndedAt).toBe(1_800_020_000_000);
    // …and nothing else moved either.
    expect(patched).toEqual({ ...gigToInput(GIG), workEndedAt: 1_800_020_000_000 });
  });

  it("omits source, so an email-captured gig is not relabelled manual", () => {
    // local-store carries the existing row's source forward when the
    // input omits it. Re-sending it is what would have to be right.
    expect("source" in gigToInput(GIG)).toBe(false);
  });
});
