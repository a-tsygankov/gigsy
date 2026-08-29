/**
 * What one client owes, as a document.
 *
 * A third output over the same ledger the CSV exports read, and it must
 * agree with them. `report-export.ts`'s header states the rule this
 * file inherits: filtering "deliberately reproduces the endpoint's SQL
 * semantics so a CSV can never disagree with the numbers it was
 * exported from". So `inRange` is imported rather than rewritten, and
 * the expense rules below are `expenseRows`' rules, not new ones.
 *
 * Pure: no DOM, no React, no formatting. The screen decides how money
 * and dates are rendered; this decides what is owed.
 */
import { inRange } from "./report-export.ts";
import { outstandingCents } from "./gig-pay.ts";
import type { Expense, Gig, ReportFilters, Service } from "./types.ts";

export interface BusinessDetails {
  name: string | null;
  address: string | null;
  contact: string | null;
  taxId: string | null;
  paymentDetails: string | null;
}

export interface InvoiceLine {
  /** Epoch ms. Every line on an invoice has a date — a gig's, or the
   *  day an expense was recorded. */
  date: number;
  description: string;
  amountCents: number;
}

export interface InvoiceDocument {
  number: string;
  issuedAt: number;
  dueAt: number;
  business: BusinessDetails;
  client: { id: string; name: string };
  /** Work: gigs, each followed by its own outstanding services. */
  lines: InvoiceLine[];
  /** Costs the client agreed to cover, kept apart from the work the
   *  way Reports keeps `reimbursableCents` apart from net. */
  expenses: InvoiceLine[];
  totalCents: number;
}

export interface BuildInvoiceInput {
  gigs: Gig[];
  services: Service[];
  expenses: Expense[];
  clientId: string;
  clientName: string;
  filters: ReportFilters;
  business: BusinessDetails;
  number: string;
  issuedAt: number;
  termsDays: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Zero-padded to four, then simply longer. A five-digit invoice is a
 *  good problem to have and must not become "INV-1234 5". */
export function formatInvoiceNumber(n: number): string {
  return `INV-${String(n).padStart(4, "0")}`;
}

/** Work that has been done and not paid for. `completed` and
 *  `delivered` are the two statuses reports.ts counts as owed; a lead
 *  or a confirmed booking has not happened yet, and a cancellation
 *  never will. */
const BILLABLE_STATUSES = new Set(["completed", "delivered"]);

export function buildInvoice(input: BuildInvoiceInput): InvoiceDocument {
  const {
    gigs, services, expenses, clientId, clientName,
    filters, business, number, issuedAt, termsDays,
  } = input;

  const billable = gigs
    .filter(
      (g) =>
        g.clientId === clientId &&
        BILLABLE_STATUSES.has(g.status) &&
        inRange(g.dateTime, filters) &&
        (outstandingCents(g) ?? 0) > 0,
    )
    .sort((a, b) => (a.dateTime ?? 0) - (b.dateTime ?? 0));

  const lines: InvoiceLine[] = [];
  for (const g of billable) {
    lines.push({
      // A billable gig has passed `inRange`, which only lets a dateless
      // gig through when there are no bounds at all — and then there is
      // nothing better to date the line by than when it was created.
      date: g.dateTime ?? g.createdAt,
      description: g.title ?? "",
      amountCents: outstandingCents(g) ?? 0,
    });
    // A service whose gig is not on the invoice is skipped even when
    // unpaid — only services under `billable` gigs are considered, so
    // this loop over `services` never runs for a settled or
    // out-of-range gig.
    for (const s of services) {
      if (s.gigId !== g.id) continue;
      const owed = (s.amountOfferedCents ?? 0) - (s.amountPaidCents ?? 0);
      if (owed <= 0) continue;
      lines.push({
        date: g.dateTime ?? g.createdAt,
        description: s.description,
        amountCents: owed,
      });
    }
  }

  // `expenseRows`' rules, one for one: an expense belongs to a client
  // only through its gig, and is dated by that gig, falling back to
  // when it was recorded. Note this does NOT require the gig to be
  // billable — a cost the client agreed to cover is owed whether or not
  // the work it attached to has been paid for.
  const gigById = new Map(gigs.map((g) => [g.id, g]));
  const billedExpenses: InvoiceLine[] = expenses
    .filter((e) => {
      if (!e.reimbursable) return false;
      const gig = e.gigId !== null ? gigById.get(e.gigId) : undefined;
      if (gig?.clientId !== clientId) return false;
      return inRange(gig.dateTime ?? e.createdAt, filters);
    })
    .map((e) => {
      const gig = gigById.get(e.gigId!);
      return {
        date: gig?.dateTime ?? e.createdAt,
        description: e.category ?? "Expense",
        amountCents: e.amountCents,
      };
    })
    .sort((a, b) => a.date - b.date);

  const totalCents =
    lines.reduce((sum, l) => sum + l.amountCents, 0) +
    billedExpenses.reduce((sum, l) => sum + l.amountCents, 0);

  return {
    number,
    issuedAt,
    dueAt: issuedAt + termsDays * DAY_MS,
    business,
    client: { id: clientId, name: clientName },
    lines,
    expenses: billedExpenses,
    totalCents,
  };
}
