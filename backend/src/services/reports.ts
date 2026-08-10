/**
 * Reports = grouped SQL over gigs/expenses (docs/plan.md §10) — no
 * reporting engine. Money stays integer cents end-to-end.
 *
 * Semantics:
 * - varianceCents = offered − paid (what's still owed/lost).
 * - netCents = paid − expenses.
 * - Additional services are income too, so their offered/paid amounts
 *   are added to their gig's month and client (a service always hangs
 *   off exactly one gig). Omitting them would under-report income on
 *   the very export a tax return is built from.
 * - Months come from gigs.date_time; an expense follows its linked
 *   gig's month (that's the month the spend belongs to economically),
 *   falling back to its own created_at when unlinked. Rows with no
 *   date land in an "unscheduled" bucket.
 * - clientId filter scopes gigs to that client and expenses/services to
 *   that client's gigs (unlinked expenses excluded there by definition).
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
    /** Portion of expensesCents the client is expected to cover. Shown
     * beside net rather than removed from it: the flag records an
     * expectation of reimbursement, not money received, so netCents
     * stays the conservative figure. */
    reimbursableCents: number;
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

  // ── services by month (always their gig's month) ───────────────
  // `s.user_id` is bound first, then the gig clauses reuse gigParams
  // (whose first element is the same userId, for `g.user_id`).
  const serviceRows = (
    await d1
      .prepare(
        `SELECT ${MONTH_EXPR("g.date_time")} AS month,
                SUM(COALESCE(s.amount_offered_cents, 0)) AS offered,
                SUM(COALESCE(s.amount_paid_cents, 0)) AS paid
         FROM gig_services s
         JOIN gigs g ON g.id = s.gig_id
         WHERE s.user_id = ? AND ${gigWhere.join(" AND ")}
         GROUP BY month`,
      )
      .bind(userId, ...gigParams)
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
                SUM(e.amount_cents) AS expenses,
                SUM(CASE WHEN e.reimbursable = 1 THEN e.amount_cents ELSE 0 END) AS reimbursable
         FROM expenses e ${expJoin}
         WHERE ${expWhere.join(" AND ")}
         GROUP BY month`,
      )
      .bind(...expParams)
      .all<{ month: string; expenses: number; reimbursable: number }>()
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
  for (const r of [...gigRows, ...serviceRows]) {
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

  const serviceClientRows = (
    await d1
      .prepare(
        `SELECT g.client_id AS clientId, c.name AS clientName,
                SUM(COALESCE(s.amount_offered_cents, 0)) AS offered,
                SUM(COALESCE(s.amount_paid_cents, 0)) AS paid
         FROM gig_services s
         JOIN gigs g ON g.id = s.gig_id
         LEFT JOIN clients c ON c.id = g.client_id
         WHERE s.user_id = ? AND ${gigWhere.join(" AND ")}
         GROUP BY g.client_id, c.name`,
      )
      .bind(userId, ...gigParams)
      .all<{
        clientId: string | null;
        clientName: string | null;
        offered: number;
        paid: number;
      }>()
  ).results;

  // Merge gig and service money per client, preserving the query's
  // ordering (named clients alphabetically, "no client" last).
  const clients = new Map<string, ClientRow>();
  for (const r of [...clientRows, ...serviceClientRows]) {
    const key = r.clientId ?? "";
    const row = clients.get(key) ?? {
      clientId: r.clientId,
      clientName: r.clientName,
      offeredCents: 0,
      paidCents: 0,
    };
    row.offeredCents += r.offered;
    row.paidCents += r.paid;
    clients.set(key, row);
  }
  const byClient: ClientRow[] = [...clients.values()].sort((a, b) =>
    a.clientName === null || b.clientName === null
      ? Number(a.clientName === null) - Number(b.clientName === null)
      : a.clientName.localeCompare(b.clientName),
  );

  // ── totals ─────────────────────────────────────────────────────
  const offeredCents = byMonth.reduce((sum, r) => sum + r.offeredCents, 0);
  const paidCents = byMonth.reduce((sum, r) => sum + r.paidCents, 0);
  const expensesCents = byMonth.reduce((sum, r) => sum + r.expensesCents, 0);
  const reimbursableCents = expenseRows.reduce((sum, r) => sum + r.reimbursable, 0);

  return {
    totals: {
      offeredCents,
      paidCents,
      varianceCents: offeredCents - paidCents,
      expensesCents,
      reimbursableCents,
      netCents: paidCents - expensesCents,
    },
    byMonth,
    byClient,
  };
}
