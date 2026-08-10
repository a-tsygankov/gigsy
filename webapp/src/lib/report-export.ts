/**
 * CSV export row builders (docs/plan.md §10, Phase 7 plan).
 *
 * Pure functions over the local Dexie ledger — exports are generated
 * client-side, which is both necessary (the API authenticates with a
 * bearer header, so a download link could not carry auth) and useful
 * (exports work offline).
 *
 * The rows are shaped the way an accountant reads them, not the way
 * the tables are stored: gigs and their additional services are both
 * income lines, expenses are their own sheet, and the monthly summary
 * mirrors the on-screen table. Filtering deliberately reproduces the
 * endpoint's SQL semantics so a CSV can never disagree with the
 * numbers it was exported from.
 */
import type { Client, Expense, Gig, ReportFilters, ReportSummary, Service } from "./types.ts";
import { centsToInput } from "./money.ts";
import type { CsvValue } from "./csv.ts";

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** "2026-08" → "Aug 2026"; the backend's dateless bucket → "No date".
 * Parsed by hand: `new Date("2026-08")` is UTC midnight and would
 * render as the previous month in any negative-offset timezone. */
export function monthLabel(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (m === null) return "No date";
  return `${MONTHS[Number(m[2]) - 1] ?? month} ${m[1]}`;
}

/** Epoch ms → local YYYY-MM-DD (empty when there is no date). */
export function isoDate(ms: number | null): string {
  if (ms === null) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Range test matching the endpoint's SQL: bounds are inclusive, and
 * a dateless row drops out as soon as a bound exists (SQL comparisons
 * against NULL are never true). */
export function inRange(ms: number | null, filters: ReportFilters): boolean {
  if (filters.from === undefined && filters.to === undefined) return true;
  if (ms === null) return false;
  if (filters.from !== undefined && ms < filters.from) return false;
  if (filters.to !== undefined && ms > filters.to) return false;
  return true;
}

const money = (cents: number | null): string => centsToInput(cents ?? 0);

export const INCOME_HEADERS = [
  "date",
  "client",
  "kind",
  "description",
  "status",
  "offered",
  "paid",
  "outstanding",
  "notes",
];

export const EXPENSE_HEADERS = [
  "date",
  "category",
  "amount",
  "reimbursable",
  "client",
  "gig",
  "notes",
];

export const SUMMARY_HEADERS = ["month", "offered", "paid", "expenses", "net"];

interface DatedRow {
  sortKey: number;
  cells: CsvValue[];
}

/** One row per gig plus one per additional service — services carry
 * real money and inherit their gig's date and client. */
export function incomeRows(
  gigs: Gig[],
  services: Service[],
  clients: Client[],
  filters: ReportFilters,
): CsvValue[][] {
  const clientName = new Map(clients.map((c) => [c.id, c.name]));
  const gigById = new Map(gigs.map((g) => [g.id, g]));

  const included = (gig: Gig): boolean =>
    inRange(gig.dateTime, filters) &&
    (filters.clientId === undefined || gig.clientId === filters.clientId);

  const rows: DatedRow[] = [];

  for (const gig of gigs) {
    if (!included(gig)) continue;
    const offered = gig.amountOfferedCents ?? 0;
    const paid = gig.amountPaidCents ?? 0;
    rows.push({
      sortKey: gig.dateTime ?? Number.MAX_SAFE_INTEGER,
      cells: [
        isoDate(gig.dateTime),
        gig.clientId !== null ? (clientName.get(gig.clientId) ?? "") : "No client",
        "gig",
        gig.location ?? "",
        gig.status,
        money(offered),
        money(paid),
        money(Math.max(0, offered - paid)),
        gig.notes ?? "",
      ],
    });
  }

  for (const service of services) {
    // A service without its gig has no date or client to inherit —
    // skip it rather than invent them.
    const gig = gigById.get(service.gigId);
    if (gig === undefined || !included(gig)) continue;
    const offered = service.amountOfferedCents ?? 0;
    const paid = service.amountPaidCents ?? 0;
    rows.push({
      sortKey: gig.dateTime ?? Number.MAX_SAFE_INTEGER,
      cells: [
        isoDate(gig.dateTime),
        gig.clientId !== null ? (clientName.get(gig.clientId) ?? "") : "No client",
        "service",
        service.description,
        service.isCompleted ? "completed" : "open",
        money(offered),
        money(paid),
        money(Math.max(0, offered - paid)),
        "",
      ],
    });
  }

  return rows.sort((a, b) => a.sortKey - b.sortKey).map((r) => r.cells);
}

/** Expenses, dated by their linked gig where there is one — the same
 * rule the report uses to decide which month a spend belongs to. */
export function expenseRows(
  expenses: Expense[],
  gigs: Gig[],
  clients: Client[],
  filters: ReportFilters,
): CsvValue[][] {
  const clientName = new Map(clients.map((c) => [c.id, c.name]));
  const gigById = new Map(gigs.map((g) => [g.id, g]));

  const rows: DatedRow[] = [];

  for (const expense of expenses) {
    const gig = expense.gigId !== null ? gigById.get(expense.gigId) : undefined;
    // A client filter inner-joins gigs on the server, so an unlinked
    // expense cannot belong to the selected client.
    if (filters.clientId !== undefined && gig?.clientId !== filters.clientId) continue;
    const effective = gig?.dateTime ?? expense.createdAt;
    if (!inRange(effective, filters)) continue;

    rows.push({
      sortKey: effective,
      cells: [
        isoDate(effective),
        expense.category ?? "Uncategorized",
        money(expense.amountCents),
        expense.reimbursable ? "yes" : "no",
        gig?.clientId != null ? (clientName.get(gig.clientId) ?? "") : "",
        gig !== undefined ? (gig.location ?? "Untitled gig") : "Not linked",
        expense.notes ?? "",
      ],
    });
  }

  return rows.sort((a, b) => a.sortKey - b.sortKey).map((r) => r.cells);
}

/** The on-screen monthly table, verbatim. */
export function summaryRows(byMonth: ReportSummary["byMonth"]): CsvValue[][] {
  return byMonth.map((m) => [
    monthLabel(m.month),
    money(m.offeredCents),
    money(m.paidCents),
    money(m.expensesCents),
    money(m.netCents),
  ]);
}
