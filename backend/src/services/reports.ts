/**
 * Reports = grouped SQL over gigs/expenses/payments (docs/plan.md §10)
 * — no reporting engine. Money stays integer cents end-to-end.
 *
 * Two different questions both get called "paid" here, and mixing them
 * up is the bug this file used to have (migration 0016,
 * services/paid-totals.ts):
 *   - "How much has THIS GIG (or this client's gigs) been paid" reads
 *     `gigs.amount_paid_cents` / `gig_services.amount_paid_cents` — a
 *     per-gig figure, derived server-side from `payment_allocations`
 *     by services/paid-totals.ts, and never money by itself.
 *   - "How much money did I RECEIVE" reads `payments.amount_cents`
 *     directly. A payment can be split across gigs, or not yet split
 *     at all — a deposit banked before anyone decides which gigs it
 *     covers is still money received.
 * `totals.paidCents` below answers the second question: it is the
 * per-gig sum (which already reflects every allocation, so a split
 * payment is counted once, at each gig it actually funded) PLUS
 * whatever part of a payment has no allocation yet. Omitting that
 * remainder would make a payment that arrived before anyone recorded
 * what it was for simply vanish from "money received" until someone
 * did the bookkeeping — the opposite of the point of recording it at
 * all. `byMonth`/`byClient` stay per-gig/per-client figures: an
 * unallocated remainder isn't attributable to a month or a client, so
 * it is deliberately left out of both and only ever surfaces in the
 * top-level total.
 *
 * - "Offered" money from a GIG means `gigs.expected_cents`: its offer
 *   when the gig is fixed, rate × time when it is hourly. Summing
 *   `amount_offered_cents` instead reported every hourly gig as zero,
 *   because there it is only an optional override (domain/gig-pay.ts).
 *   The column is derived and kept current by GigsRepo.upsert
 *   (migration 0014). `gig_services` keeps its own
 *   `amount_offered_cents`, because a service is a flat amount with no
 *   pay type — and has no allocations of its own, only a hand-set
 *   `amount_paid_cents`, because payment_allocations links a payment to
 *   a gig, not to a service.
 * - owedCents = work done and unpaid: per `completed` gig (and its
 *   services), max(0, expected − paid). This used to be offered − paid
 *   over every gig in the period, which counted speculative leads as
 *   debts and let an overpayment on one gig cancel a shortfall on
 *   another. It now answers the same question as the dashboard's
 *   "Unpaid — waiting on clients", within the report's filters. It
 *   reads the per-gig `amount_paid_cents`, on purpose: work is only
 *   "owed" to the extent no payment has been attributed to it yet, so
 *   an unallocated payment sitting elsewhere must not reduce what a
 *   specific gig appears to still be owed.
 * - netCents = paid − expenses, where "paid" is the same money-received
 *   figure as `totals.paidCents` (including the unallocated remainder)
 *   — an unattributed deposit is still cash in hand.
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
 * - A cancelled gig is excluded from offered/paid/owed and from its
 *   own services (gigWhere, below) — it fell through, so none of that
 *   promised money is real. Its EXPENSES are a deliberate exception:
 *   the expenses query never filters on gig status, on purpose. Travel
 *   booked or materials bought before a gig cancelled were still spent
 *   — cancelling the job doesn't refund them — so they keep reducing
 *   net exactly as they would have if the gig had gone ahead. The same
 *   exclusion has a corollary for the money-received total: an
 *   allocation against a cancelled gig counts as allocated (so it is
 *   not "unallocated"), but the cancelled gig's own paid total is
 *   excluded here same as always — that slice of a payment is simply
 *   not reported anywhere in this file. Pre-existing behaviour, not a
 *   gap opened by allocations: a cancelled gig's paid money was never
 *   reported before this table existed either.
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
    /** Money received: the per-gig/per-client paid figures (already
     *  correct per allocation — a split payment counts once, at each
     *  gig it funded) plus whatever part of a payment has not been
     *  allocated to any gig yet. "How much did I receive", not "how
     *  much of my work is paid for" — see the file header. */
    paidCents: number;
    /** Work done and not (fully) paid for: per `completed` gig,
     *  max(0, expected − paid), plus the same for its services. Matches
     *  the dashboard's "Unpaid — waiting on clients", narrowed by the
     *  report's filters. */
    owedCents: number;
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
  // A cancelled gig fell through: it stops counting as money the same
  // way it stops occupying time (services/availability.ts) and
  // stops holding a calendar event (calendar/sync-service.ts). Every
  // query below that reuses gigWhere spans all the remaining statuses,
  // so the exclusion belongs here once rather than being repeated at
  // each call site.
  const gigWhere: string[] = ["g.user_id = ?", "g.status != 'cancelled'"];
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

  // "How much has this gig been paid", not "how much did I receive":
  // g.amount_paid_cents is the per-gig sum of its allocations, kept
  // current by services/paid-totals.ts. Rolled into byMonth/byClient
  // below, and from there into totals.paidCents — which then adds the
  // unallocated remainder of every payment, the one thing this figure
  // can't see (see "unallocated payments", further down).
  const gigRows = (
    await d1
      .prepare(
        `SELECT ${MONTH_EXPR("g.date_time")} AS month,
                SUM(COALESCE(g.expected_cents, 0)) AS offered,
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
  // No status filter here, deliberately, even for a cancelled gig's
  // linked expenses: the header comment explains why (money spent
  // doesn't un-spend itself when the job falls through).
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

  // ── unallocated payments (money received, not yet assigned) ────
  // "How much did I receive", answered from payments.amount_cents
  // directly — the other half of the money-received figure, alongside
  // the per-gig amounts already summed into gigRows/serviceRows above.
  // Every allocated cent is already counted there (recomputePaidTotals
  // wrote it onto the gig it was allocated to), so this query must only
  // pick up the remainder — payment.amount_cents minus whatever sums to
  // its allocations — or a fully-allocated payment would be counted
  // twice. A payment with an amount but no allocations at all (the
  // `payments.gigId` compatibility path always adds one, but a payment
  // saved before it is attributed to any gig has none yet) is entirely
  // "unallocated" by this definition, which is exactly right — none of
  // it has been assigned to a gig.
  //
  // Filtered by the payment's own date (paidAt, falling back to
  // createdAt the same way an unlinked expense does) and by
  // payments.client_id — not by any gig, because an unallocated payment
  // by definition names no gig for the gigWhere/date-via-gig logic
  // above to filter on.
  const paymentEffectiveTs = "COALESCE(p.paid_at, p.created_at)";
  const paymentWhere: string[] = ["p.user_id = ?"];
  const paymentParams: unknown[] = [userId, userId];
  if (filters.from !== undefined) {
    paymentWhere.push(`${paymentEffectiveTs} >= ?`);
    paymentParams.push(filters.from);
  }
  if (filters.to !== undefined) {
    paymentWhere.push(`${paymentEffectiveTs} <= ?`);
    paymentParams.push(filters.to);
  }
  if (filters.clientId !== undefined) {
    paymentWhere.push("p.client_id = ?");
    paymentParams.push(filters.clientId);
  }
  const unallocatedRow = await d1
    .prepare(
      `SELECT SUM(p.amount_cents - COALESCE(a.allocated, 0)) AS total
       FROM payments p
       LEFT JOIN (
         SELECT payment_id, SUM(amount_cents) AS allocated
         FROM payment_allocations
         WHERE user_id = ?
         GROUP BY payment_id
       ) a ON a.payment_id = p.id
       WHERE ${paymentWhere.join(" AND ")}`,
    )
    .bind(...paymentParams)
    .first<{ total: number | null }>();
  const unallocatedCents = unallocatedRow?.total ?? 0;

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
  // "How much has this client's work been paid" — the per-gig figure
  // again (g.amount_paid_cents), which already reflects every
  // allocation against that client's gigs. An unallocated remainder of
  // a payment that names this client isn't attributed to any gig, so
  // it is deliberately left out here too; it only ever shows up in
  // totals.paidCents.
  const clientRows = (
    await d1
      .prepare(
        `SELECT g.client_id AS clientId, c.name AS clientName,
                SUM(COALESCE(g.expected_cents, 0)) AS offered,
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

  // ── still owed ─────────────────────────────────────────────────
  // Its own query rather than a total over the rows above, because it
  // asks a narrower question than they answer. Two differences, and
  // both change the number:
  //
  //   - `completed` only. A lead is speculative and a confirmed gig has
  //     not happened yet; neither is a debt. The dashboard calls that
  //     money "Expected" and this now agrees with it. `cancelled` is
  //     out too, and for a different reason: it isn't a debt, it's work
  //     that no longer counts at all (gigWhere, above).
  //   - Clamped per gig. Σoffered − Σpaid lets an overpayment on one
  //     gig cancel a shortfall on another, so the total could read
  //     lower than what any client actually owes — and, with a generous
  //     tip somewhere, could even read zero while invoices sat unpaid.
  //
  // The gig clauses are reused so the report's date and client filters
  // still apply.
  //
  // Placeholders are positional `?` throughout this file, so the
  // per-gig service subquery is written that way too rather than reused
  // from dashboard.ts, which numbers them `?1`. Mixing the two styles
  // does not error — SQLite just carries on numbering from the highest
  // it has seen — it silently shifts every later parameter by one, and
  // the report would filter by a date where it meant a user id. The
  // subquery is bound first because it appears first in the statement,
  // exactly as the services-by-month query above does.
  const owedRow = await d1
    .prepare(
      `SELECT SUM(
                MAX(0, COALESCE(g.expected_cents, 0) - COALESCE(g.amount_paid_cents, 0))
                + MAX(0, COALESCE(s.s_offered, 0) - COALESCE(s.s_paid, 0))
              ) AS total
       FROM gigs g
       LEFT JOIN (
         SELECT gig_id,
                SUM(COALESCE(amount_offered_cents, 0)) AS s_offered,
                SUM(COALESCE(amount_paid_cents, 0)) AS s_paid
         FROM gig_services
         WHERE user_id = ?
         GROUP BY gig_id
       ) s ON s.gig_id = g.id
       WHERE ${gigWhere.join(" AND ")} AND g.status = 'completed'`,
    )
    .bind(userId, ...gigParams)
    .first<{ total: number | null }>();
  const owedCents = owedRow?.total ?? 0;

  // ── totals ─────────────────────────────────────────────────────
  const offeredCents = byMonth.reduce((sum, r) => sum + r.offeredCents, 0);
  // Money received = the per-gig figures already summed into byMonth
  // (correct per allocation, so a split payment counts once) PLUS
  // whatever part of a payment isn't allocated to any gig yet. See the
  // file header and the "unallocated payments" query above — this is
  // the one total in this file that is not simply a sum over byMonth.
  const paidCents = byMonth.reduce((sum, r) => sum + r.paidCents, 0) + unallocatedCents;
  const expensesCents = byMonth.reduce((sum, r) => sum + r.expensesCents, 0);
  const reimbursableCents = expenseRows.reduce((sum, r) => sum + r.reimbursable, 0);

  return {
    totals: {
      offeredCents,
      paidCents,
      owedCents,
      expensesCents,
      reimbursableCents,
      netCents: paidCents - expensesCents,
    },
    byMonth,
    byClient,
  };
}
