import { describe, expect, it } from "vitest";
import { DUPLICATE_DATE_MESSAGE, collectGigDates } from "./gig-dates.ts";
import { localInputToMs } from "./datetime.ts";

// Local-time strings, resolved the way the form resolves them, so the
// expectations do not depend on the machine's zone.
const MON = "2026-09-14T09:00";
const TUE = "2026-09-15T09:00";
const WED = "2026-09-16T14:30";
const ms = (s: string) => localInputToMs(s);

describe("collectGigDates", () => {
  it("is one undated gig when nothing is entered — today's behaviour", () => {
    // `[null]`, never `[]`: an empty list would create nothing, and the
    // form has always saved an undated gig when the date was left blank.
    expect(collectGigDates("", [])).toEqual({ ok: true, dateTimes: [null] });
  });

  it("is one dated gig when only the primary is set", () => {
    expect(collectGigDates(MON, [])).toEqual({ ok: true, dateTimes: [ms(MON)] });
  });

  it("ignores blank extra rows", () => {
    // An opened-and-never-filled row is not a gig anyone meant to make.
    expect(collectGigDates(MON, ["", "", ""])).toEqual({ ok: true, dateTimes: [ms(MON)] });
    expect(collectGigDates("", [""])).toEqual({ ok: true, dateTimes: [null] });
  });

  it("uses the extras as the dates when the primary is blank", () => {
    // The primary box is first, not special.
    expect(collectGigDates("", [TUE, WED])).toEqual({
      ok: true,
      dateTimes: [ms(TUE), ms(WED)],
    });
  });

  it("keeps the order as entered, primary first", () => {
    // Never sorted: the first gig made is the one in the primary box,
    // which is the one the person is taken to when there is only one.
    expect(collectGigDates(WED, [MON, TUE])).toEqual({
      ok: true,
      dateTimes: [ms(WED), ms(MON), ms(TUE)],
    });
  });

  it("refuses two rows that resolve to the same moment", () => {
    expect(collectGigDates(MON, [TUE, MON])).toEqual({
      ok: false,
      message: DUPLICATE_DATE_MESSAGE,
    });
    // Also between two extras, not only against the primary.
    expect(collectGigDates("", [TUE, TUE])).toEqual({
      ok: false,
      message: DUPLICATE_DATE_MESSAGE,
    });
  });

  it("states the fault and the fix in the message", () => {
    expect(DUPLICATE_DATE_MESSAGE).toBe("Two of the dates are the same — remove one.");
  });
});
