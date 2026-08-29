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
import { gigDisplayTitle } from "./gig-title.ts";
import type { Expense, Gig, GigStatus, ReportFilters, Service } from "./types.ts";

export interface BusinessDetails {
  name: string | null;
  address: string | null;
  contact: string | null;
  taxId: string | null;
  paymentDetails: string | null;
}

export interface InvoiceLine {
  /** Epoch ms. A gig (or service) line dates by the gig's own date,
   *  falling back to when the gig was created for the rare dateless
   *  case. An expense line normally dates by its gig too, falling back
   *  to when the expense itself was recorded. */
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
  /** Work that qualifies but cannot be priced — `completed` or
   *  `delivered`, in range, for this client, but `expectedCents` is
   *  null because an hourly gig has no rate or a fixed one has no
   *  amount. Deliberately NOT billed: a $0.00 line is worse than no
   *  line. Surfaced so the document can say so, because otherwise the
   *  user prints, sends, and under-bills with nothing anywhere
   *  admitting it. */
  unpricedGigs: { id: string; description: string }[];
  totalCents: number;
}

export interface BuildInvoiceInput {
  gigs: Gig[];
  services: Service[];
  expenses: Expense[];
  /** The client this invoice bills. A parameter, not a filter:
   *  `filters.clientId` (below) is a `ReportFilters` field the CSV
   *  exports honour, but this function ignores it — `clientId` here is
   *  the only thing that decides which client's gigs and expenses are
   *  selected. */
  clientId: string;
  clientName: string;
  filters: ReportFilters;
  business: BusinessDetails;
  number: string;
  issuedAt: number;
  termsDays: number;
}

/** Zero-padded to four, then simply longer. A five-digit invoice is a
 *  good problem to have and must not become "INV-1234 5". */
export function formatInvoiceNumber(n: number): string {
  return `INV-${String(n).padStart(4, "0")}`;
}

/** Work that has been done and not paid for. `completed` and
 *  `delivered` are the two statuses `backend/src/services/reports.ts`
 *  counts as owed; a lead or a confirmed booking has not happened yet,
 *  and a cancellation never will. */
const BILLABLE_STATUSES = new Set<GigStatus>(["completed", "delivered"]);

export function buildInvoice(input: BuildInvoiceInput): InvoiceDocument {
  const {
    gigs, services, expenses, clientId, clientName,
    filters, business, number, issuedAt, termsDays,
  } = input;

  // Sorted by the same date every line below actually carries: a gig's
  // own date, or — reachable only because `inRange` lets a dateless gig
  // through when there are no bounds at all — its `createdAt` once it
  // has none. Either way this refuses to let a dateless gig sort as
  // epoch 0 (which would print it first, ahead of everything real).
  // report-export.ts's `incomeRows` hit the same fork and refused the
  // same way, by a different route: it pushes a dateless row to the
  // very end (`gig.dateTime ?? Number.MAX_SAFE_INTEGER`) rather than
  // dating it by `createdAt`.
  const qualifying = gigs
    .filter(
      (g) =>
        g.clientId === clientId &&
        BILLABLE_STATUSES.has(g.status) &&
        inRange(g.dateTime, filters),
    )
    .sort((a, b) => (a.dateTime ?? a.createdAt) - (b.dateTime ?? b.createdAt));

  const lines: InvoiceLine[] = [];
  const unpricedGigs: { id: string; description: string }[] = [];

  for (const g of qualifying) {
    // `outstandingCents` is null, not zero, when `expectedCents` is
    // unknown (an hourly gig with no rate, a fixed one with no
    // amount) — see gig-pay.ts. Billing $0.00 for it would be a
    // silent under-bill; skip it, but say so, rather than pretend
    // nothing was owed.
    const outstanding = outstandingCents(g);
    if (outstanding === null) {
      unpricedGigs.push({ id: g.id, description: gigDisplayTitle(g, clientName) });
      continue;
    }
    if (outstanding <= 0) continue; // settled

    // A billable gig has passed `inRange`, which only lets a dateless
    // gig through when there are no bounds at all — and then there is
    // nothing better to date the line by than when it was created.
    const date = g.dateTime ?? g.createdAt;
    lines.push({
      date,
      // Not `g.title` directly: a gig commonly has no title of its own
      // (gig-title.ts), and a blank line item on a bill a client
      // receives is worse than a wrong one — the reader cannot tell
      // what they are being charged for. `gigDisplayTitle` falls back
      // to the gig's notes, then to the client's own name.
      description: gigDisplayTitle(g, clientName),
      amountCents: outstanding,
    });
    // A service whose gig is not on the invoice is skipped even when
    // unpaid — and so is a service whose gig is unpriced, above — only
    // services under a BILLED gig are considered, so this loop never
    // runs for a settled, unpriced, or out-of-range gig.
    for (const s of services) {
      if (s.gigId !== g.id) continue;
      const owed = (s.amountOfferedCents ?? 0) - (s.amountPaidCents ?? 0);
      if (owed <= 0) continue;
      lines.push({
        date,
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
    .flatMap((e) => {
      if (!e.reimbursable || e.gigId === null) return [];
      const gig = gigById.get(e.gigId);
      if (gig === undefined || gig.clientId !== clientId) return [];
      const date = gig.dateTime ?? e.createdAt;
      if (!inRange(date, filters)) return [];
      return [{
        date,
        // "Expense", not expenseRows' "Uncategorized" — deliberately
        // different wording, because the audience is: a client reading
        // a bill, not a bookkeeper reading a spreadsheet.
        description: e.category ?? "Expense",
        amountCents: e.amountCents,
      }];
    })
    .sort((a, b) => a.date - b.date);

  const totalCents =
    lines.reduce((sum, l) => sum + l.amountCents, 0) +
    billedExpenses.reduce((sum, l) => sum + l.amountCents, 0);

  // Calendar days, not a fixed number of milliseconds: adding
  // `termsDays * 86_400_000` drifts across a DST boundary (issued
  // 23:30 with 14-day terms can land at 00:30 on the 16th instead of
  // the 15th), and a due date printed on a bill has to read as the
  // calendar day meant, not whatever falls exactly that many hours
  // later.
  const due = new Date(issuedAt);
  due.setDate(due.getDate() + termsDays);

  return {
    number,
    issuedAt,
    dueAt: due.getTime(),
    business,
    client: { id: clientId, name: clientName },
    lines,
    expenses: billedExpenses,
    unpricedGigs,
    totalCents,
  };
}
