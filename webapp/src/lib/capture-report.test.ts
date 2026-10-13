import { describe, expect, it } from "vitest";
import {
  CAPTURE_UNREADABLE_MESSAGE,
  captureCorrections,
  captureReportMessage,
  correctedFromForm,
  type CaptureFormState,
  type CorrectedCapture,
} from "./capture-report.ts";
import { formatLocalMoment, msToLocalInput } from "./datetime.ts";
import { formatMoney } from "./format.ts";
import type { DraftExtracted } from "./types.ts";

// Local moments, as epoch ms — what extraction hands back.
const MON = new Date("2026-09-14T09:00").getTime();
const TUE = new Date("2026-09-15T09:00").getTime();

const RECOGNIZED: DraftExtracted = {
  kind: "gig",
  clientName: "Acme",
  matchedClientId: "c1",
  matchConfidence: 0.95,
  location: "Expo Hall",
  dateTimeMs: MON,
  dateTimesMs: [MON, TUE],
  amountOfferedCents: 12500,
  category: null,
  notes: null,
};

/** What the review form holds for RECOGNIZED when nobody touched it. */
const UNTOUCHED: CorrectedCapture = {
  kind: "gig",
  clientName: "Acme",
  location: "Expo Hall",
  dateTimes: [MON, TUE],
  amountCents: 12500,
  category: null,
  notes: null,
};

function form(overrides: Partial<CaptureFormState> = {}): CaptureFormState {
  return {
    kind: "gig",
    client: { kind: "existing", id: "c1" },
    clients: [{ id: "c1", name: "Acme" }],
    location: " Expo Hall ",
    dateTime: msToLocalInput(MON),
    extraDates: [msToLocalInput(TUE), ""],
    amount: "125.00",
    category: "",
    notes: "  ",
    ...overrides,
  };
}

describe("correctedFromForm", () => {
  it("reads the review form into the corrected shape", () => {
    expect(correctedFromForm(form())).toEqual(UNTOUCHED);
  });

  it("names the client by the choice: existing by the list, new by what was typed, none as null", () => {
    expect(correctedFromForm(form()).clientName).toBe("Acme");
    expect(
      correctedFromForm(form({ client: { kind: "new", name: " Full Field " } })).clientName,
    ).toBe("Full Field");
    expect(correctedFromForm(form({ client: { kind: "none" } })).clientName).toBeNull();
    // A client deleted since capture is not in the list; no name is
    // honest, a stale id is not a name.
    expect(
      correctedFromForm(form({ client: { kind: "existing", id: "gone" } })).clientName,
    ).toBeNull();
  });

  it("drops blank date rows and reads a blank or unreadable amount as none", () => {
    const state = form({ dateTime: "", extraDates: ["", msToLocalInput(TUE)], amount: "abc" });
    expect(correctedFromForm(state)).toMatchObject({ dateTimes: [TUE], amountCents: null });
    expect(correctedFromForm(form({ amount: "" })).amountCents).toBeNull();
  });
});

describe("captureCorrections", () => {
  it("lists nothing when the form still holds what was read", () => {
    expect(captureCorrections(RECOGNIZED, UNTOUCHED)).toEqual([]);
  });

  it("lists only the fields that differ, labelled and shown on both sides", () => {
    const rows = captureCorrections(RECOGNIZED, {
      ...UNTOUCHED,
      clientName: "Acme Events",
      amountCents: 15000,
    });
    expect(rows).toEqual([
      { field: "clientName", label: "Client", recognized: "Acme", corrected: "Acme Events" },
      {
        field: "amountCents",
        label: "Amount",
        recognized: formatMoney(12500),
        corrected: formatMoney(15000),
      },
    ]);
  });

  it("compares money as cents, not as typed text", () => {
    // "125" and "125.00" are the same amount; only the number matters.
    expect(captureCorrections(RECOGNIZED, correctedFromForm(form({ amount: "125" })))).toEqual([]);
  });

  it("compares dates as moments, in order, and shows them as a person reads them", () => {
    const rows = captureCorrections(RECOGNIZED, { ...UNTOUCHED, dateTimes: [MON] });
    expect(rows).toEqual([
      {
        field: "dateTimes",
        label: "Date & time",
        recognized: `${formatLocalMoment(MON)}; ${formatLocalMoment(TUE)}`,
        corrected: formatLocalMoment(MON),
      },
    ]);
    // Same moments, other order: a different reading.
    expect(
      captureCorrections(RECOGNIZED, { ...UNTOUCHED, dateTimes: [TUE, MON] }).map((r) => r.field),
    ).toEqual(["dateTimes"]);
  });

  it("ignores seconds the form cannot hold", () => {
    // The date box holds minutes; a provider's stray seconds are not a
    // correction the person made.
    const withSeconds: DraftExtracted = { ...RECOGNIZED, dateTimesMs: [MON + 42_000, TUE] };
    expect(captureCorrections(withSeconds, UNTOUCHED)).toEqual([]);
  });

  it("falls back to dateTimeMs when the draft predates dateTimesMs", () => {
    const { dateTimesMs: _dropped, ...older } = RECOGNIZED;
    expect(captureCorrections(older, { ...UNTOUCHED, dateTimes: [MON] })).toEqual([]);
  });

  it("trims strings, treats blank as missing, and is case-sensitive", () => {
    expect(captureCorrections(RECOGNIZED, { ...UNTOUCHED, location: "  Expo Hall " })).toEqual([]);
    expect(captureCorrections({ ...RECOGNIZED, notes: "  " }, UNTOUCHED)).toEqual([]);
    expect(captureCorrections(RECOGNIZED, { ...UNTOUCHED, location: "expo hall" })).toEqual([
      { field: "location", label: "Location", recognized: "Expo Hall", corrected: "expo hall" },
    ]);
    // Removing a value shows as a dash, not as an empty cell.
    expect(captureCorrections(RECOGNIZED, { ...UNTOUCHED, location: null })).toEqual([
      { field: "location", label: "Location", recognized: "Expo Hall", corrected: "—" },
    ]);
  });

  it("reports a kind change, and reads an expense's amount from amountCents", () => {
    const receipt: DraftExtracted = {
      kind: "expense",
      amountCents: 1800,
      category: "parking",
      dateTimeMs: MON,
    };
    const rows = captureCorrections(receipt, {
      kind: "payment",
      clientName: null,
      location: null,
      dateTimes: [MON],
      amountCents: 1800,
      category: "parking",
      notes: null,
    });
    expect(rows).toEqual([
      { field: "kind", label: "Kind", recognized: "Expense", corrected: "Payment" },
    ]);
  });

  it("shows an undecided kind as such when the person settles it", () => {
    const rows = captureCorrections({ ...RECOGNIZED, kind: "unknown" }, UNTOUCHED);
    expect(rows).toEqual([
      { field: "kind", label: "Kind", recognized: "Not sure", corrected: "Gig" },
    ]);
  });
});

describe("captureReportMessage", () => {
  const amountRow = {
    field: "amountCents" as const,
    label: "Amount",
    recognized: "$125.00",
    corrected: "$150.00",
  };
  const clientRow = {
    field: "clientName" as const,
    label: "Client",
    recognized: "Acme",
    corrected: "Acme Events",
  };

  it("uses what the person typed, trimmed, over anything generated", () => {
    expect(captureReportMessage("  The total was smudged. ", [amountRow])).toBe(
      "The total was smudged.",
    );
    expect(captureReportMessage("It was a PDF.", null)).toBe("It was a PDF.");
  });

  it("generates a line naming the corrected fields when nothing was typed", () => {
    expect(captureReportMessage("", [clientRow, amountRow])).toBe(
      "Capture read 2 fields wrong: Client, Amount",
    );
    expect(captureReportMessage("   ", [amountRow])).toBe("Capture read 1 field wrong: Amount");
  });

  it("has nothing to say for a review with no text and no corrections", () => {
    expect(captureReportMessage("", [])).toBeNull();
  });

  it("says the capture could not read it when extraction failed and nothing was typed", () => {
    expect(captureReportMessage("", null)).toBe(CAPTURE_UNREADABLE_MESSAGE);
    expect(CAPTURE_UNREADABLE_MESSAGE).toBe("Capture could not read this.");
  });
});
