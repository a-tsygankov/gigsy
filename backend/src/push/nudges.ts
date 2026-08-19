/**
 * Deciding what is worth interrupting someone for.
 *
 * Push covers exactly the gap a calendar cannot: work with no date.
 * A confirmed, dated gig is already on the calendar with a reminder
 * (Phase 9), so notifying about it again would be the app competing
 * with itself — and duplicate notifications are how people learn to
 * ignore an app entirely.
 *
 * That leaves two things that quietly cost money:
 *   - a lead nobody chased, which never appears on any calendar;
 *   - work that was done and never paid for.
 *
 * At most one nudge per run, carrying the single most pressing item.
 * A list of five things is a chore; one thing is a prompt.
 */
import { and, eq, lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { gigs, clients } from "../db/schema.ts";

export interface Nudge {
  /** Identity of what we are saying, so the same fact is not repeated
   * day after day. Changes when the underlying situation changes. */
  key: string;
  title: string;
  body: string;
  /** Where tapping the notification should land. */
  path: string;
}

export interface NudgeThresholds {
  staleLeadDays: number;
  unpaidDays: number;
}

export const DEFAULT_THRESHOLDS: NudgeThresholds = {
  // A week is long enough that a lead is genuinely drifting, short
  // enough that the offer may still be open.
  staleLeadDays: 7,
  // Two weeks is past most invoice courtesies without being punitive.
  unpaidDays: 14,
};

const DAY_MS = 24 * 60 * 60 * 1000;

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * The single most pressing item for this user, or null when there is
 * nothing worth saying. Unpaid work outranks a stale lead: it is money
 * already earned.
 */
export async function selectNudge(
  d1: D1Database,
  userId: string,
  now: number,
  thresholds: NudgeThresholds = DEFAULT_THRESHOLDS,
): Promise<Nudge | null> {
  const db = drizzle(d1);
  const clientNames = new Map(
    (await db.select().from(clients).where(eq(clients.userId, userId))).map((c) => [
      c.id,
      c.name,
    ]),
  );
  const nameOf = (clientId: string | null): string =>
    (clientId !== null ? clientNames.get(clientId) : undefined) ?? "a client";

  // ── money already earned ────────────────────────────────────────
  const unpaidCutoff = now - thresholds.unpaidDays * DAY_MS;
  const unpaid = await db
    .select()
    .from(gigs)
    .where(
      and(
        eq(gigs.userId, userId),
        eq(gigs.status, "completed"),
        lt(gigs.modifiedAt, unpaidCutoff),
      ),
    );

  // Oldest first — the one that has been outstanding longest.
  //
  // `expectedCents`, not `amountOfferedCents`: on an hourly gig the
  // offer column is only an optional override of rate × time, so an
  // hourly gig read as owing nothing and was never nudged about — the
  // one case where silence costs the user money. The column is derived
  // and kept current by GigsRepo.upsert (migration 0014).
  const owed = unpaid
    .map((gig) => ({
      gig,
      outstanding: (gig.expectedCents ?? 0) - (gig.amountPaidCents ?? 0),
    }))
    .filter((row) => row.outstanding > 0)
    .sort((a, b) => a.gig.modifiedAt - b.gig.modifiedAt);

  const oldest = owed[0];
  if (oldest !== undefined) {
    const days = Math.floor((now - oldest.gig.modifiedAt) / DAY_MS);
    return {
      key: `unpaid:${oldest.gig.id}`,
      title: "Still unpaid",
      body: `${nameOf(oldest.gig.clientId)} hasn't paid ${money(
        oldest.outstanding,
      )} — ${days} days now.`,
      path: `/gigs/${oldest.gig.id}`,
    };
  }

  // ── work that may still be winnable ─────────────────────────────
  const leadCutoff = now - thresholds.staleLeadDays * DAY_MS;
  const staleLeads = await db
    .select()
    .from(gigs)
    .where(
      and(
        eq(gigs.userId, userId),
        eq(gigs.status, "lead"),
        lt(gigs.modifiedAt, leadCutoff),
      ),
    );

  const stalest = staleLeads.sort((a, b) => a.modifiedAt - b.modifiedAt)[0];
  if (stalest !== undefined) {
    const days = Math.floor((now - stalest.modifiedAt) / DAY_MS);
    const what = stalest.location ?? nameOf(stalest.clientId);
    return {
      key: `lead:${stalest.id}`,
      title: "Lead going cold",
      body: `${what} has sat untouched for ${days} days. Confirm it or let it go?`,
      path: `/gigs/${stalest.id}`,
    };
  }

  return null;
}

/**
 * Whether to actually send. Repeating the same fact daily is how an
 * app trains someone to swipe it away without reading, so a nudge is
 * only sent when it is either new or a day has passed.
 */
export function shouldSend(
  nudge: Nudge,
  lastPushKey: string | null,
  lastPushAt: number | null,
  now: number,
): boolean {
  if (lastPushAt !== null && now - lastPushAt < DAY_MS) return false;
  return nudge.key !== lastPushKey || now - (lastPushAt ?? 0) >= 7 * DAY_MS;
}
