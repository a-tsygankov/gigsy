import { describe, it, expect } from "vitest";
import {
  monthLabel,
  isoDate,
  inRange,
  incomeRows,
  expenseRows,
  summaryRows,
  INCOME_HEADERS,
  EXPENSE_HEADERS,
  SUMMARY_HEADERS,
} from "./report-export.ts";
import type { Client, Expense, Gig, Service } from "./types.ts";

const SEP = Date.UTC(2026, 8, 10, 12); // 2026-09-10
const OCT = Date.UTC(2026, 9, 5, 12); // 2026-10-05

const acme: Client = {
  id: "c1",
  name: "Acme",
  contactInfo: null,
  notes: null,
  createdAt: 0,
  modifiedAt: 0,
};

function gig(over: Partial<Gig> = {}): Gig {
  return {
    id: "g1",
    clientId: "c1",
    title: null,
    status: "completed",
    location: "Costco on 5th",
    dateTime: SEP,
    durationMinutes: null,
    payType: "fixed",
    hourlyRateCents: null,
    workStartedAt: null,
    workEndedAt: null,
    breakMinutes: null,
    calendarEventId: null,
    amountOfferedCents: 20000,
    amountPaidCents: 15000,
    expectedCents: null,
    notes: null,
    source: null,
    createdAt: SEP,
    modifiedAt: SEP,
    ...over,
  };
}

function service(over: Partial<Service> = {}): Service {
  return {
    id: "s1",
    gigId: "g1",
    description: "Overtime hour",
    amountOfferedCents: 4000,
    amountPaidCents: 4000,
    paymentId: null,
    isCompleted: true,
    createdAt: SEP,
    modifiedAt: SEP,
    ...over,
  };
}

function expense(over: Partial<Expense> = {}): Expense {
  return {
    id: "e1",
    gigId: "g1",
    amountCents: 2350,
    category: "parking",
    receiptR2Key: null,
    notes: null,
    reimbursable: false,
    createdAt: SEP,
    modifiedAt: SEP,
    ...over,
  };
}

describe("monthLabel", () => {
  it("renders a month key as a human month without timezone drift", () => {
    // new Date("2026-01") would parse as UTC midnight and render as
    // December in any negative-offset zone — hence manual parsing.
    expect(monthLabel("2026-01")).toBe("Jan 2026");
    expect(monthLabel("2026-08")).toBe("Aug 2026");
    expect(monthLabel("2026-12")).toBe("Dec 2026");
  });

  it("names the dateless bucket in words", () => {
    expect(monthLabel("unscheduled")).toBe("No date");
  });
});

describe("isoDate", () => {
  it("formats epoch ms as YYYY-MM-DD", () => {
    expect(isoDate(Date.UTC(2026, 8, 10, 12))).toMatch(/^2026-09-\d{2}$/);
  });

  it("renders a missing date as empty, never as a fake one", () => {
    expect(isoDate(null)).toBe("");
  });
});

describe("inRange", () => {
  it("accepts anything when unfiltered", () => {
    expect(inRange(SEP, {})).toBe(true);
    expect(inRange(null, {})).toBe(true);
  });

  it("applies inclusive bounds", () => {
    expect(inRange(SEP, { from: SEP })).toBe(true);
    expect(inRange(SEP, { to: SEP })).toBe(true);
    expect(inRange(SEP, { from: OCT })).toBe(false);
    expect(inRange(OCT, { to: SEP })).toBe(false);
  });

  // The endpoint's SQL compares date_time against the bound, and SQL
  // NULL comparisons are never true — dateless rows drop out of a
  // filtered report. The CSV has to agree with the numbers on screen.
  it("drops dateless rows once a bound exists, matching the backend SQL", () => {
    expect(inRange(null, { from: SEP })).toBe(false);
    expect(inRange(null, { to: OCT })).toBe(false);
  });
});

describe("incomeRows", () => {
  it("emits one row per gig with client, amounts and outstanding", () => {
    const rows = incomeRows([gig()], [], [acme], {});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual([
      "2026-09-10",
      "Acme",
      "gig",
      "Costco on 5th",
      "completed",
      "200.00",
      "150.00",
      "50.00",
      "",
    ]);
  });

  it("bills a gig split-paid by one payment at its own share, not the whole payment", () => {
    // Phase 4 made gigs.amountPaidCents derived: it is the sum of the
    // allocations pointing at that gig, not the amount of any payment.
    // One $150 payment split $100/$50 across two gigs must therefore
    // export as $100 and $50 — the figure each gig screen shows. The
    // failure this guards against is a per-gig column quietly carrying
    // a payment-sized number, which would make the CSV disagree with
    // the app it was exported from and overstate income by the split.
    const rows = incomeRows(
      [
        gig({ id: "g1", amountOfferedCents: 20000, amountPaidCents: 10000 }),
        gig({
          id: "g2",
          location: "Pier 3",
          amountOfferedCents: 12000,
          amountPaidCents: 5000,
        }),
      ],
      [],
      [acme],
      {},
    );

    expect(rows[0]?.slice(5, 8)).toEqual(["200.00", "100.00", "100.00"]);
    expect(rows[1]?.slice(5, 8)).toEqual(["120.00", "50.00", "70.00"]);

    // Neither row carries the payment's own $150 anywhere.
    expect(rows.flat()).not.toContain("150.00");
  });

  it("bills an hourly gig at its computed pay, not at nothing", () => {
    // The regression: an hourly gig is stored with amountOfferedCents
    // null on purpose, so the CSV billed every one of them at $0.00.
    const rows = incomeRows(
      [
        gig({
          payType: "hourly",
          hourlyRateCents: 5000,
          durationMinutes: 480,
          amountOfferedCents: null,
          amountPaidCents: null,
          expectedCents: 40000,
        }),
      ],
      [],
      [acme],
      {},
    );
    expect(rows[0]?.slice(5, 8)).toEqual(["400.00", "0.00", "400.00"]);
  });

  it("bills an unsynced hourly gig from the local derivation", () => {
    // Same gig before it has reached the server: exports work offline,
    // which is half the reason they are generated client-side.
    const rows = incomeRows(
      [
        gig({
          payType: "hourly",
          hourlyRateCents: 5000,
          durationMinutes: 480,
          amountOfferedCents: null,
          amountPaidCents: null,
          expectedCents: null,
        }),
      ],
      [],
      [acme],
      {},
    );
    expect(rows[0]?.slice(5, 8)).toEqual(["400.00", "0.00", "400.00"]);
  });

  it("emits services as their own income lines, dated and attributed to their gig", () => {
    const rows = incomeRows([gig()], [service()], [acme], {});
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual([
      "2026-09-10",
      "Acme",
      "service",
      "Overtime hour",
      "completed",
      "40.00",
      "40.00",
      "0.00",
      "",
    ]);
  });

  it("writes absent values in words, never blank-but-meaningful", () => {
    const rows = incomeRows(
      [gig({ clientId: null, location: null, dateTime: null })],
      [],
      [acme],
      {},
    );
    expect(rows[0]?.slice(0, 4)).toEqual(["", "No client", "gig", ""]);
  });

  it("treats an unset amount as zero rather than dropping the row", () => {
    const rows = incomeRows(
      [gig({ amountOfferedCents: null, amountPaidCents: null })],
      [],
      [acme],
      {},
    );
    expect(rows[0]?.slice(5, 8)).toEqual(["0.00", "0.00", "0.00"]);
  });

  it("applies the date filter to gigs and to their services", () => {
    const rows = incomeRows([gig()], [service()], [acme], { from: OCT });
    expect(rows).toEqual([]);
  });

  it("applies the client filter to gigs and to their services", () => {
    const rows = incomeRows([gig()], [service()], [acme], { clientId: "other" });
    expect(rows).toEqual([]);
  });

  it("orders rows by date, oldest first", () => {
    const rows = incomeRows(
      [gig({ id: "g2", dateTime: OCT }), gig({ id: "g1", dateTime: SEP })],
      [],
      [acme],
      {},
    );
    expect(rows.map((r) => r[0])).toEqual(["2026-09-10", "2026-10-05"]);
  });

  it("drops a service whose gig is gone rather than inventing a date", () => {
    const rows = incomeRows([], [service({ gigId: "missing" })], [acme], {});
    expect(rows).toEqual([]);
  });

  it("has a header for every column it emits", () => {
    const rows = incomeRows([gig()], [service()], [acme], {});
    for (const row of rows) expect(row).toHaveLength(INCOME_HEADERS.length);
  });
});

describe("expenseRows", () => {
  it("emits the expense with its category, amount and linked gig", () => {
    const rows = expenseRows([expense()], [gig()], [acme], {});
    expect(rows).toEqual([
      ["2026-09-10", "parking", "23.50", "no", "Acme", "Costco on 5th", ""],
    ]);
  });

  it("dates an unlinked expense by its own creation, and says so", () => {
    const rows = expenseRows([expense({ gigId: null })], [], [acme], {});
    expect(rows[0]?.[0]).toMatch(/^2026-09-\d{2}$/);
    expect(rows[0]?.slice(4, 6)).toEqual(["", "Not linked"]);
  });

  it("marks whether the client should cover the cost", () => {
    const rows = expenseRows(
      [expense({ reimbursable: true })],
      [gig()],
      [acme],
      {},
    );
    expect(rows[0]?.[3]).toBe("yes");
  });

  it("labels a missing category rather than leaving it blank", () => {
    const rows = expenseRows([expense({ category: null })], [gig()], [acme], {});
    expect(rows[0]?.[1]).toBe("Uncategorized");
  });

  it("filters by the linked gig's date, matching the report's month rule", () => {
    expect(expenseRows([expense()], [gig()], [acme], { from: OCT })).toEqual([]);
    expect(expenseRows([expense()], [gig()], [acme], { to: OCT })).toHaveLength(1);
  });

  it("excludes unlinked expenses when a client filter is set", () => {
    // The endpoint inner-joins gigs for a client filter, so an
    // expense with no gig cannot belong to that client.
    const rows = expenseRows([expense({ gigId: null })], [], [acme], {
      clientId: "c1",
    });
    expect(rows).toEqual([]);
  });

  it("has a header for every column it emits", () => {
    const rows = expenseRows([expense()], [gig()], [acme], {});
    for (const row of rows) expect(row).toHaveLength(EXPENSE_HEADERS.length);
  });
});

describe("summaryRows", () => {
  it("maps the API month rows to labelled decimal money", () => {
    const rows = summaryRows([
      {
        month: "2026-09",
        offeredCents: 24000,
        paidCents: 19000,
        expensesCents: 2350,
        netCents: 16650,
      },
    ]);
    expect(rows).toEqual([["Sep 2026", "240.00", "190.00", "23.50", "166.50"]]);
    expect(rows[0]).toHaveLength(SUMMARY_HEADERS.length);
  });
});
