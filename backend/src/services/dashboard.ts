/**
 * Dashboard aggregates (user feature spec, 2026-08-08):
 * - completedCount — gigs `completed|paid`, all time.
 * - expectedCents — promised money still ahead: offered on `lead|
 *   confirmed` gigs (optionally windowed by future date) plus their
 *   services' offered amounts. The window applies ONLY here — that's
 *   the dashboard's "timeframe for future" selector.
 * - unpaidCents + unpaidJobs — work done but not (fully) paid: per
 *   `completed` gig, max(0, offered−paid) + Σ services max(0,
 *   offered−paid); rows carry the client name and both breakdowns for
 *   the drill-down. Money owed has no expiry — never windowed.
 */
export interface DashboardWindow {
  futureFrom?: number;
  futureTo?: number;
}

export interface UnpaidJob {
  gigId: string;
  clientId: string | null;
  clientName: string | null;
  dateTime: number | null;
  offeredCents: number;
  paidCents: number;
  servicesOfferedCents: number;
  servicesPaidCents: number;
  outstandingCents: number;
}

export interface DashboardSummary {
  completedCount: number;
  expectedCents: number;
  unpaidCents: number;
  unpaidJobs: UnpaidJob[];
}

/** Per-gig service totals as a reusable subquery fragment. */
const SERVICE_SUMS = `
  SELECT gig_id,
         SUM(COALESCE(amount_offered_cents, 0)) AS s_offered,
         SUM(COALESCE(amount_paid_cents, 0)) AS s_paid
  FROM gig_services
  WHERE user_id = ?1
  GROUP BY gig_id`;

export async function dashboardSummary(
  d1: D1Database,
  userId: string,
  window: DashboardWindow,
): Promise<DashboardSummary> {
  const completed = await d1
    .prepare(
      `SELECT COUNT(*) AS n FROM gigs
       WHERE user_id = ?1 AND status IN ('completed', 'paid')`,
    )
    .bind(userId)
    .first<{ n: number }>();

  const futureClauses: string[] = [];
  const futureParams: unknown[] = [userId];
  if (window.futureFrom !== undefined) {
    futureParams.push(window.futureFrom);
    futureClauses.push(`g.date_time >= ?${futureParams.length}`);
  }
  if (window.futureTo !== undefined) {
    futureParams.push(window.futureTo);
    futureClauses.push(`g.date_time <= ?${futureParams.length}`);
  }
  const futureFilter = futureClauses.length
    ? `AND ${futureClauses.join(" AND ")}`
    : "";

  const expected = await d1
    .prepare(
      `SELECT SUM(COALESCE(g.amount_offered_cents, 0) + COALESCE(s.s_offered, 0)) AS total
       FROM gigs g
       LEFT JOIN (${SERVICE_SUMS}) s ON s.gig_id = g.id
       WHERE g.user_id = ?1 AND g.status IN ('lead', 'confirmed') ${futureFilter}`,
    )
    .bind(...futureParams)
    .first<{ total: number | null }>();

  const unpaidRows = (
    await d1
      .prepare(
        `SELECT g.id AS gigId, g.client_id AS clientId, c.name AS clientName,
                g.date_time AS dateTime,
                COALESCE(g.amount_offered_cents, 0) AS offered,
                COALESCE(g.amount_paid_cents, 0) AS paid,
                COALESCE(s.s_offered, 0) AS sOffered,
                COALESCE(s.s_paid, 0) AS sPaid
         FROM gigs g
         LEFT JOIN clients c ON c.id = g.client_id
         LEFT JOIN (${SERVICE_SUMS}) s ON s.gig_id = g.id
         WHERE g.user_id = ?1 AND g.status = 'completed'
         ORDER BY g.date_time`,
      )
      .bind(userId)
      .all<{
        gigId: string;
        clientId: string | null;
        clientName: string | null;
        dateTime: number | null;
        offered: number;
        paid: number;
        sOffered: number;
        sPaid: number;
      }>()
  ).results;

  const unpaidJobs: UnpaidJob[] = unpaidRows
    .map((row) => ({
      gigId: row.gigId,
      clientId: row.clientId,
      clientName: row.clientName,
      dateTime: row.dateTime,
      offeredCents: row.offered,
      paidCents: row.paid,
      servicesOfferedCents: row.sOffered,
      servicesPaidCents: row.sPaid,
      outstandingCents:
        Math.max(0, row.offered - row.paid) + Math.max(0, row.sOffered - row.sPaid),
    }))
    .filter((job) => job.outstandingCents > 0);

  return {
    completedCount: completed?.n ?? 0,
    expectedCents: expected?.total ?? 0,
    unpaidCents: unpaidJobs.reduce((sum, job) => sum + job.outstandingCents, 0),
    unpaidJobs,
  };
}
