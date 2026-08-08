/**
 * Reports = grouped SQL over gigs/expenses (docs/plan.md §10) — no
 * reporting engine. Money stays integer cents end-to-end.
 *
 * Semantics:
 * - varianceCents = offered − paid (what's still owed/lost).
 * - netCents = paid − expenses.
 * - Months come from gigs.date_time; an expense follows its linked
 *   gig's month (that's the month the spend belongs to economically),
 *   falling back to its own created_at when unlinked. Rows with no
 *   date land in an "unscheduled" bucket.
 * - clientId filter scopes gigs to that client and expenses to that
 *   client's gigs (unlinked expenses excluded there by definition).
 */
export interface ReportFilters {
  from?: number;
  to?: number;
  clientId?: string;
}

export interface MonthRow {
  month: string;
  offeredCents: number;
  paidCents: number;
  expensesCents: number;
  netCents: number;
}

export interface ClientRow {
  clientId: string | null;
  clientName: string | null;
  offeredCents: number;
  paidCents: number;
}

export interface ReportSummary {
  totals: {
    offeredCents: number;
    paidCents: number;
    varianceCents: number;
    expensesCents: number;
    netCents: number;
  };
  byMonth: MonthRow[];
  byClient: ClientRow[];
}

const MONTH_EXPR = (tsExpr: string) =>
  `COALESCE(strftime('%Y-%m', ${tsExpr}/1000, 'unixepoch'), 'unscheduled')`;

export async function reportSummary(
  d1: D1Database,
  userId: string,
  filters: ReportFilters,
): Promise<ReportSummary> {
  // ── gigs by month ──────────────────────────────────────────────
  // Clauses are `g.`-qualified because the by-client query below
  // reuses them in a join where bare `user_id` is ambiguous.
  const gigWhere: string[] = ["g.user_id = ?"];
  const gigParams: unknown[] = [userId];
  if (filters.from !== undefined) {
    gigWhere.push("g.date_time >= ?");
    gigParams.push(filters.from);
  }
  if (filters.to !== undefined) {
    gigWhere.push("g.date_time <= ?");
    gigParams.push(filters.to);
  }
  if (filters.clientId !== undefined) {
    gigWhere.push("g.client_id = ?");
    gigParams.push(filters.clientId);
  }

  const gigRows = (
    await d1
      .prepare(
        `SELECT ${MONTH_EXPR("g.date_time")} AS month,
                SUM(COALESCE(g.amount_offered_cents, 0)) AS offered,
                SUM(COALESCE(g.amount_paid_cents, 0)) AS paid
         FROM gigs g
         WHERE ${gigWhere.join(" AND ")}
         GROUP BY month`,
      )
      .bind(...gigParams)
      .all<{ month: string; offered: number; paid: number }>()
  ).results;

  // ── expenses by month (linked gig's month, else own created_at) ─
  const effectiveTs = "COALESCE(g.date_time, e.created_at)";
  const expWhere: string[] = ["e.user_id = ?"];
  const expParams: unknown[] = [userId];
  let expJoin = "LEFT JOIN gigs g ON g.id = e.gig_id";
  if (filters.clientId !== undefined) {
    expJoin = "JOIN gigs g ON g.id = e.gig_id AND g.client_id = ?";
    expParams.unshift(filters.clientId);
  }
  if (filters.from !== undefined) {
    expWhere.push(`${effectiveTs} >= ?`);
    expParams.push(filters.from);
  }
  if (filters.to !== undefined) {
    expWhere.push(`${effectiveTs} <= ?`);
    expParams.push(filters.to);
  }

  const expenseRows = (
    await d1
      .prepare(
        `SELECT ${MONTH_EXPR(effectiveTs)} AS month,
                SUM(e.amount_cents) AS expenses
         FROM expenses e ${expJoin}
         WHERE ${expWhere.join(" AND ")}
         GROUP BY month`,
      )
      .bind(...expParams)
      .all<{ month: string; expenses: number }>()
  ).results;

  // ── merge months ───────────────────────────────────────────────
  const months = new Map<string, MonthRow>();
  const monthOf = (key: string): MonthRow => {
    let row = months.get(key);
    if (row === undefined) {
      row = { month: key, offeredCents: 0, paidCents: 0, expensesCents: 0, netCents: 0 };
      months.set(key, row);
    }
    return row;
  };
  for (const r of gigRows) {
    const row = monthOf(r.month);
    row.offeredCents += r.offered;
    row.paidCents += r.paid;
  }
  for (const r of expenseRows) {
    monthOf(r.month).expensesCents += r.expenses;
  }
  const byMonth = [...months.values()]
    .map((r) => ({ ...r, netCents: r.paidCents - r.expensesCents }))
    .sort((a, b) => a.month.localeCompare(b.month));

  // ── by client ──────────────────────────────────────────────────
  const clientRows = (
    await d1
      .prepare(
        `SELECT g.client_id AS clientId, c.name AS clientName,
                SUM(COALESCE(g.amount_offered_cents, 0)) AS offered,
                SUM(COALESCE(g.amount_paid_cents, 0)) AS paid
         FROM gigs g
         LEFT JOIN clients c ON c.id = g.client_id
         WHERE ${gigWhere.join(" AND ")}
         GROUP BY g.client_id, c.name
         ORDER BY (c.name IS NULL), c.name`,
      )
      .bind(...gigParams)
      .all<{
        clientId: string | null;
        clientName: string | null;
        offered: number;
        paid: number;
      }>()
  ).results;

  const byClient: ClientRow[] = clientRows.map((r) => ({
    clientId: r.clientId,
    clientName: r.clientName,
    offeredCents: r.offered,
    paidCents: r.paid,
  }));

  // ── totals ─────────────────────────────────────────────────────
  const offeredCents = byMonth.reduce((sum, r) => sum + r.offeredCents, 0);
  const paidCents = byMonth.reduce((sum, r) => sum + r.paidCents, 0);
  const expensesCents = byMonth.reduce((sum, r) => sum + r.expensesCents, 0);

  return {
    totals: {
      offeredCents,
      paidCents,
      varianceCents: offeredCents - paidCents,
      expensesCents,
      netCents: paidCents - expensesCents,
    },
    byMonth,
    byClient,
  };
}
