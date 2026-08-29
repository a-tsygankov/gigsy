import { describe, expect, it } from "vitest";
import { buildInvoice, formatInvoiceNumber } from "./invoice.ts";
import { expenseRows } from "./report-export.ts";
import { parseMoney } from "./money.ts";
import type { Client, Expense, Gig, ReportFilters, Service } from "./types.ts";

const BUSINESS = {
  name: "Tsygankov Ltd",
  address: "1 Example St",
  contact: "me@example.com",
  taxId: null,
  paymentDetails: "IBAN 123",
};

const DAY = 24 * 60 * 60 * 1000;
const JAN = Date.UTC(2026, 0, 15);

function gig(over: Partial<Gig>): Gig {
  return {
    id: "g1",
    clientId: "c1",
    title: "Tasting",
    dateTime: JAN,
    durationMinutes: 180,
    status: "completed",
    payType: "fixed",
    amountOfferedCents: 10000,
    amountPaidCents: 0,
    expectedCents: 10000,
    hourlyRateCents: null,
    workStartedAt: null,
    workEndedAt: null,
    breakMinutes: null,
    location: null,
    notes: null,
    source: "manual",
    parentGigId: null,
    createdAt: JAN,
    modifiedAt: JAN,
    ...over,
  } as Gig;
}

function service(over: Partial<Service>): Service {
  return {
    id: "s1",
    gigId: "g1",
    description: "Extra hour",
    amountOfferedCents: 5000,
    amountPaidCents: 0,
    paymentId: null,
    isCompleted: true,
    createdAt: JAN,
    modifiedAt: JAN,
    ...over,
  };
}

function expense(over: Partial<Expense>): Expense {
  return {
    id: "e1",
    gigId: "g1",
    amountCents: 2000,
    category: "parking",
    receiptR2Key: null,
    notes: null,
    reimbursable: true,
    createdAt: JAN,
    modifiedAt: JAN,
    ...over,
  };
}

const build = (over: Partial<Parameters<typeof buildInvoice>[0]> = {}) =>
  buildInvoice({
    gigs: [gig({})],
    services: [],
    expenses: [],
    clientId: "c1",
    clientName: "Acme",
    filters: {},
    business: BUSINESS,
    number: "INV-0001",
    issuedAt: JAN,
    termsDays: 14,
    ...over,
  });

describe("formatInvoiceNumber", () => {
  it("pads to four digits and keeps going past them", () => {
    expect(formatInvoiceNumber(1)).toBe("INV-0001");
    expect(formatInvoiceNumber(42)).toBe("INV-0042");
    expect(formatInvoiceNumber(12345)).toBe("INV-12345");
  });
});

describe("buildInvoice — which gigs become lines", () => {
  it("bills a completed gig with something outstanding", () => {
    const doc = build();
    expect(doc.lines).toHaveLength(1);
    expect(doc.lines[0]).toMatchObject({ description: "Tasting", amountCents: 10000 });
    expect(doc.totalCents).toBe(10000);
  });

  it("bills the remainder of a part-paid gig, not the whole fee", () => {
    const doc = build({ gigs: [gig({ amountPaidCents: 4000 })] });
    expect(doc.lines[0]?.amountCents).toBe(6000);
    expect(doc.totalCents).toBe(6000);
  });

  it("skips a settled gig", () => {
    expect(build({ gigs: [gig({ amountPaidCents: 10000 })] }).lines).toEqual([]);
  });

  it("skips a gig that is not completed or delivered", () => {
    expect(build({ gigs: [gig({ status: "confirmed" })] }).lines).toEqual([]);
    expect(build({ gigs: [gig({ status: "lead" })] }).lines).toEqual([]);
    expect(build({ gigs: [gig({ status: "cancelled" })] }).lines).toEqual([]);
    expect(build({ gigs: [gig({ status: "delivered" })] }).lines).toHaveLength(1);
  });

  it("skips another client's gig", () => {
    expect(build({ gigs: [gig({ clientId: "c2" })] }).lines).toEqual([]);
  });

  it("honours the date range, and drops a dateless gig once a bound exists", () => {
    expect(build({ filters: { from: JAN + DAY } }).lines).toEqual([]);
    expect(build({ filters: { to: JAN - DAY } }).lines).toEqual([]);
    expect(build({ filters: { from: JAN - DAY, to: JAN + DAY } }).lines).toHaveLength(1);
    expect(build({ gigs: [gig({ dateTime: null })], filters: { from: JAN } }).lines).toEqual([]);
  });
});

describe("buildInvoice — line descriptions", () => {
  it("derives a titleless gig's description from its notes, not a blank line", () => {
    // gigDisplayTitle (gig-title.ts) falls back title → first non-blank
    // line of notes → client name. Checked against its real behaviour,
    // not assumed: this asserts the notes fallback specifically.
    const doc = build({
      gigs: [gig({ title: null, notes: "Tasting menu prep\nExtra detail below" })],
    });
    expect(doc.lines[0]?.description).toBe("Tasting menu prep");
  });
});

describe("buildInvoice — services", () => {
  it("bills a service's own remainder under its gig", () => {
    const doc = build({ services: [service({ amountPaidCents: 1000 })] });
    expect(doc.lines).toHaveLength(2);
    expect(doc.lines[1]).toMatchObject({ description: "Extra hour", amountCents: 4000 });
    expect(doc.totalCents).toBe(14000);
  });

  it("skips a settled service", () => {
    expect(build({ services: [service({ amountPaidCents: 5000 })] }).lines).toHaveLength(1);
  });

  it("skips a service whose gig is not on the invoice", () => {
    // Deliberate: a line with no work above it reads as a mistake to
    // whoever receives the invoice. See the spec.
    const doc = build({
      gigs: [gig({ amountPaidCents: 10000 })],
      services: [service({})],
    });
    expect(doc.lines).toEqual([]);
    expect(doc.totalCents).toBe(0);
  });
});

describe("buildInvoice — reimbursable expenses", () => {
  it("lists a reimbursable expense separately and adds it to the total", () => {
    const doc = build({ expenses: [expense({})] });
    expect(doc.lines).toHaveLength(1);
    expect(doc.expenses).toHaveLength(1);
    expect(doc.expenses[0]).toMatchObject({ description: "parking", amountCents: 2000 });
    expect(doc.totalCents).toBe(12000);
  });

  it("skips a non-reimbursable expense", () => {
    expect(build({ expenses: [expense({ reimbursable: false })] }).expenses).toEqual([]);
  });

  it("skips an expense with no gig, because it cannot belong to a client", () => {
    // Matches expenseRows: "A client filter inner-joins gigs on the
    // server, so an unlinked expense cannot belong to the selected
    // client."
    expect(build({ expenses: [expense({ gigId: null })] }).expenses).toEqual([]);
  });

  it("dates an expense by its gig when the gig has a date, not by when it was recorded", () => {
    // The filter window brackets the gig's date but not the expense's
    // own `createdAt` (90 days later) — the expense is included, and
    // dated JAN, only because dating prefers the gig's date.
    const doc = build({
      gigs: [gig({ dateTime: JAN })],
      expenses: [expense({ createdAt: JAN + 90 * DAY })],
      filters: { from: JAN - DAY, to: JAN + DAY },
    });
    expect(doc.expenses).toHaveLength(1);
    expect(doc.expenses[0]?.date).toBe(JAN);
  });

  it("falls back to when the expense was recorded, when its gig has no date", () => {
    // The filter window brackets `createdAt` but not JAN (where the
    // gig would sit if it had a date) — the expense is included only
    // because a dateless gig makes dating fall back to `createdAt`.
    const recordedAt = JAN + 5 * DAY;
    const doc = build({
      gigs: [gig({ dateTime: null })],
      expenses: [expense({ createdAt: recordedAt })],
      filters: { from: JAN + 4 * DAY, to: JAN + 6 * DAY },
    });
    expect(doc.expenses).toHaveLength(1);
    expect(doc.expenses[0]?.date).toBe(recordedAt);
  });

  it("bills a reimbursable expense even when its gig is settled", () => {
    // An expense is a cost the client agreed to cover; whether the WORK
    // has been paid for is a different question. This is the one place
    // expenses deliberately do not follow their gig.
    const doc = build({
      gigs: [gig({ amountPaidCents: 10000 })],
      expenses: [expense({})],
    });
    expect(doc.lines).toEqual([]);
    expect(doc.expenses).toHaveLength(1);
    expect(doc.totalCents).toBe(2000);
  });
});

describe("buildInvoice — the document", () => {
  it("carries the number, the parties, and a due date from the terms", () => {
    const doc = build({ termsDays: 30 });
    expect(doc.number).toBe("INV-0001");
    expect(doc.client).toEqual({ id: "c1", name: "Acme" });
    expect(doc.business.name).toBe("Tsygankov Ltd");
    expect(doc.issuedAt).toBe(JAN);
    expect(doc.dueAt).toBe(JAN + 30 * DAY);
  });

  it("sorts lines oldest first", () => {
    const doc = build({
      gigs: [
        gig({ id: "late", dateTime: JAN + DAY, title: "Later" }),
        gig({ id: "early", dateTime: JAN, title: "Earlier" }),
      ],
    });
    expect(doc.lines.map((l) => l.description)).toEqual(["Earlier", "Later"]);
  });
});

describe("buildInvoice — agreement with report-export.ts", () => {
  // Both files filter reimbursable expenses down to one client and one
  // date range, but through independently-written code (only `inRange`
  // is shared) — expenseRows joins on `filters.clientId`, buildInvoice
  // on its own `clientId` parameter. This pins that the two land on the
  // same reimbursable total for the same inputs, so a fix to one
  // client-linking rule that misses the other would fail here.
  it("bills the same reimbursable total that expenseRows exports for this client and range", () => {
    const clients: Client[] = [
      { id: "c1", name: "Acme", contactInfo: null, notes: null, createdAt: JAN, modifiedAt: JAN },
    ];
    const gigs = [
      gig({ id: "g1", dateTime: JAN }),
      gig({ id: "g2", dateTime: JAN + 40 * DAY, clientId: "c2" }), // other client
    ];
    const expenses = [
      expense({ id: "e1", gigId: "g1", amountCents: 2000, reimbursable: true }),
      expense({ id: "e2", gigId: "g1", amountCents: 500, reimbursable: false }),
      expense({ id: "e3", gigId: "g2", amountCents: 999, reimbursable: true }), // other client
      expense({ id: "e4", gigId: null, amountCents: 777, reimbursable: true }), // unlinked
    ];
    const filters: ReportFilters = { from: JAN - DAY, to: JAN + DAY };

    const doc = buildInvoice({
      gigs,
      services: [],
      expenses,
      clientId: "c1",
      clientName: "Acme",
      filters,
      business: BUSINESS,
      number: "INV-0001",
      issuedAt: JAN,
      termsDays: 14,
    });

    const csvRows = expenseRows(expenses, gigs, clients, { ...filters, clientId: "c1" });
    const reimbursableCsvCents = csvRows
      .filter((row) => row[3] === "yes")
      .reduce((sum, row) => sum + (parseMoney(String(row[2])) ?? 0), 0);

    expect(doc.expenses).toHaveLength(1);
    expect(doc.expenses.reduce((sum, l) => sum + l.amountCents, 0)).toBe(reimbursableCsvCents);
  });
});
