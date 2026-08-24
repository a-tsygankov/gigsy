/**
 * Dashboard aggregates (user feature spec, 2026-08-08):
 * - completedCount — gigs `completed` or `delivered`, all time: both
 *   are finished work, and delivery is a milestone within completion,
 *   not a different count. `paid` is no longer a status (migration
 *   0015): a gig that was `paid` reads `completed` now, and paid-ness
 *   is a fact about the money, not the count here.
 * - awaitingDeliveryCount — the opposite widening from every other
 *   count here: `completed` EXACTLY, never `delivered`. A delivered
 *   gig has already been handed over, so it has left the queue of work
 *   still waiting to go out the door.
 * - expectedCents — promised money still ahead: the expected pay of
 *   `lead|confirmed` gigs (optionally windowed by future date) plus
 *   their services' offered amounts. The window applies ONLY here —
 *   that's the dashboard's "timeframe for future" selector.
 * - unpaidCents + unpaidJobs — work done but not (fully) paid: per
 *   `completed`-or-`delivered` gig, max(0, expected−paid) + Σ services
 *   max(0, offered−paid); rows carry the client name and both
 *   breakdowns for the drill-down. Money owed has no expiry — never
 *   windowed.
 *
 * Both gig figures read `gigs.expected_cents`, never
 * `amount_offered_cents`: on an hourly gig the latter is only an
 * optional override of rate × time, so summing it counted every
 * hourly gig as zero. The column is derived and kept current by
 * GigsRepo.upsert (migration 0014). `gig_services` has no pay type —
 * a service is a flat amount — so its own offered column is still the
 * right thing to sum.
 *
 * `paid`, here, always asks "how much has THIS gig (or this service)
 * been paid" — never "how much money did I receive". `amount_paid_cents`
 * is the per-gig sum of its `payment_allocations` rows, recomputed by
 * services/paid-totals.ts whenever an allocation changes (migration
 * 0016), so a payment split across several gigs is already counted
 * once at each gig it actually funded — summing it again here, or
 * joining `payments` directly, would double it. Money received but not
 * yet allocated to any gig is real (a deposit banked before anyone
 * decides which jobs it covers) but deliberately doesn't appear here:
 * it isn't "unpaid work", it's unattributed money, which is a reports
 * question (reports.ts's `totals.paidCents`), not a dashboard one.
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
  /** The gig's expected pay — its offer when fixed, rate × time when
   *  hourly. The name no longer describes the source column, and is
   *  kept anyway: this is a shipped response field, and an installed
   *  PWA that has not updated yet still reads `offeredCents` off the
   *  drill-down rows. Renaming it would blank the figure on exactly
   *  the clients slowest to update. */
  offeredCents: number;
  paidCents: number;
  servicesOfferedCents: number;
  servicesPaidCents: number;
  outstandingCents: number;
}

export interface DashboardSummary {
  completedCount: number;
  /** Finished work that has not yet been handed over — `completed`
   *  EXACTLY, not `completed|delivered`. This is the one count in this
   *  file that must NOT widen: a delivered gig has already been handed
   *  over, so it does not belong in a queue whose whole purpose is
   *  what still needs delivering. */
  awaitingDeliveryCount: number;
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
      // 'delivered' counts here too: delivery is a milestone within
      // completion — the work is still done.
      `SELECT COUNT(*) AS n FROM gigs
       WHERE user_id = ?1 AND status IN ('completed', 'delivered')`,
    )
    .bind(userId)
    .first<{ n: number }>();

  // `completed` exactly, NOT the `IN ('completed','delivered')` the
  // money queries use: this is the one place where the distinction is
  // the point. Work that has been handed over is not awaiting delivery.
  const awaitingDelivery = await d1
    .prepare(
      `SELECT COUNT(*) AS n FROM gigs
       WHERE user_id = ?1 AND status = 'completed'`,
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
      `SELECT SUM(COALESCE(g.expected_cents, 0) + COALESCE(s.s_offered, 0)) AS total
       FROM gigs g
       LEFT JOIN (${SERVICE_SUMS}) s ON s.gig_id = g.id
       WHERE g.user_id = ?1 AND g.status IN ('lead', 'confirmed') ${futureFilter}`,
    )
    .bind(...futureParams)
    .first<{ total: number | null }>();

  // "How much has THIS gig been paid" — g.amount_paid_cents is the
  // per-gig sum of its payment_allocations rows (services/paid-totals.ts),
  // not a join against `payments`. No join against payments.gig_id
  // belongs here even in principle: a payment can fund several gigs, so
  // attributing it by joining payments directly would double-count it
  // at every gig it touched instead of splitting it the way the
  // allocations already do.
  const unpaidRows = (
    await d1
      .prepare(
        `SELECT g.id AS gigId, g.client_id AS clientId, c.name AS clientName,
                g.date_time AS dateTime,
                COALESCE(g.expected_cents, 0) AS offered,
                COALESCE(g.amount_paid_cents, 0) AS paid,
                COALESCE(s.s_offered, 0) AS sOffered,
                COALESCE(s.s_paid, 0) AS sPaid
         FROM gigs g
         LEFT JOIN clients c ON c.id = g.client_id
         LEFT JOIN (${SERVICE_SUMS}) s ON s.gig_id = g.id
         -- 'delivered' counts here too: delivery is a milestone, not a
         -- change in what the gig is owed.
         WHERE g.user_id = ?1 AND g.status IN ('completed', 'delivered')
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
    awaitingDeliveryCount: awaitingDelivery?.n ?? 0,
    expectedCents: expected?.total ?? 0,
    unpaidCents: unpaidJobs.reduce((sum, job) => sum + job.outstandingCents, 0),
    unpaidJobs,
  };
}
