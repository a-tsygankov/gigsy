/** User-scoped data access for `payment_allocations`. Same contract as
 * PaymentsRepo — which gigs a payment paid for, and how much of it went
 * to each. `gigs.amountPaidCents` is derived from these rows by
 * services/paid-totals.ts and is never written here.
 *
 * Unlike the other repos, upsert also checks that the `paymentId` and
 * `gigId` an allocation names belong to the caller, not just that any
 * existing row with the same id does. An allocation is a link between
 * two rows the caller owns — accepting one that points at somebody
 * else's payment or gig would let a caller read (via the totals it
 * produces) or spend against money and work that isn't theirs.
 *
 * IMPORTANT for callers, and especially for whoever wires up the route
 * or the sync case: this check is defence-in-depth, not the caller's
 * ownership check. `"forbidden"` here means one of two different
 * things — the row itself belongs to someone else (the same case every
 * other repo reports, and the convention is to turn it into a generic
 * 404, e.g. routes/gigs.ts and lwwUpsert in services/sync.ts), OR the
 * `paymentId`/`gigId` named in the payload belongs to someone else. The
 * result deliberately does not distinguish which, because turning it
 * into a richer type would break the shared `UpsertResult<T> |
 * "forbidden"` shape every repo returns — the shape services/sync.ts
 * dispatches generic LWW handling over.
 *
 * That means a bare `"forbidden"` cannot produce what the plan actually
 * requires: the route needs a 400 with "…does not reference your
 * client"-style wording (mirroring routes/gigs.ts's clientId check),
 * and the sync case needs an error matching /does not reference your
 * gig/. Both of those must still run their OWN ownership check and
 * produce their own message — do not treat this repo-level check as
 * having already done that job.
 *
 * The two extra SELECTs this adds to every upsert are cheap
 * (indexed primary-key lookups) and are kept even though the route and
 * sync case each check the same thing themselves: this is the one
 * place every write path — CRUD route, /api/sync, and any future
 * caller — funnels through, so it is the one place the invariant can't
 * be skipped by a caller that forgets its own check.
 */
import { and, desc, eq } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { gigs, payments, paymentAllocations } from "../db/schema.ts";
import type { UpsertResult, WriteStamps } from "./clients.ts";

export type AllocationRecord = typeof paymentAllocations.$inferSelect;

export interface AllocationData {
  paymentId: string;
  gigId: string;
  amountCents: number;
}

/**
 * Does a payment holding this many allocations count as split?
 *
 * The one rule behind `replaceSoleAllocation`'s refusal to let a legacy
 * `gigId` rewrite a split payment. Exported as a function of the count
 * — not re-derived at each call site — so that
 * services/payment-invariants.ts can gate I4 on exactly the same
 * question, from a list it has already fetched, without a second query
 * and without a second copy of the rule to drift.
 */
export function isSplitPayment(allocationCount: number): boolean {
  return allocationCount > 1;
}

export class AllocationsRepo {
  constructor(private readonly db: DrizzleD1Database) {}

  static for(d1: D1Database): AllocationsRepo {
    return new AllocationsRepo(drizzle(d1));
  }

  async list(userId: string): Promise<AllocationRecord[]> {
    return this.db
      .select()
      .from(paymentAllocations)
      .where(eq(paymentAllocations.userId, userId))
      .orderBy(desc(paymentAllocations.createdAt));
  }

  async listByPayment(userId: string, paymentId: string): Promise<AllocationRecord[]> {
    return this.db
      .select()
      .from(paymentAllocations)
      .where(
        and(
          eq(paymentAllocations.userId, userId),
          eq(paymentAllocations.paymentId, paymentId),
        ),
      );
  }

  async listByGig(userId: string, gigId: string): Promise<AllocationRecord[]> {
    return this.db
      .select()
      .from(paymentAllocations)
      .where(
        and(eq(paymentAllocations.userId, userId), eq(paymentAllocations.gigId, gigId)),
      );
  }

  async get(userId: string, id: string): Promise<AllocationRecord | null> {
    const rows = await this.db
      .select()
      .from(paymentAllocations)
      .where(and(eq(paymentAllocations.id, id), eq(paymentAllocations.userId, userId)));
    return rows[0] ?? null;
  }

  async upsert(
    userId: string,
    id: string,
    data: AllocationData,
    stamps: WriteStamps,
  ): Promise<UpsertResult<AllocationRecord>> {
    const modifiedAt = stamps.modifiedAt ?? stamps.now;
    const existingRows = await this.db
      .select()
      .from(paymentAllocations)
      .where(eq(paymentAllocations.id, id));
    const existing = existingRows[0];

    if (existing !== undefined && existing.userId !== userId) {
      return "forbidden";
    }

    // The payment and gig this allocation names must both be the
    // caller's own. Checked on every write (insert and update alike),
    // the same way GigsRepo.upsert recomputes expectedCents on every
    // write rather than trusting it was right last time.
    const [paymentRow] = await this.db
      .select({ userId: payments.userId })
      .from(payments)
      .where(eq(payments.id, data.paymentId));
    if (paymentRow === undefined || paymentRow.userId !== userId) {
      return "forbidden";
    }
    const [gigRow] = await this.db
      .select({ userId: gigs.userId })
      .from(gigs)
      .where(eq(gigs.id, data.gigId));
    if (gigRow === undefined || gigRow.userId !== userId) {
      return "forbidden";
    }

    if (existing !== undefined) {
      const updated = await this.db
        .update(paymentAllocations)
        .set({ ...data, modifiedAt, serverModifiedAt: stamps.now })
        .where(and(eq(paymentAllocations.id, id), eq(paymentAllocations.userId, userId)))
        .returning();
      return { record: updated[0]!, created: false };
    }

    const inserted = await this.db
      .insert(paymentAllocations)
      .values({
        id,
        userId,
        ...data,
        createdAt: stamps.now,
        modifiedAt,
        serverModifiedAt: stamps.now,
      })
      .returning();
    return { record: inserted[0]!, created: true };
  }

  async remove(userId: string, id: string): Promise<boolean> {
    const deleted = await this.db
      .delete(paymentAllocations)
      .where(and(eq(paymentAllocations.id, id), eq(paymentAllocations.userId, userId)))
      .returning({ id: paymentAllocations.id });
    return deleted.length > 0;
  }

  /**
   * Deletes every allocation for one payment — called when the payment
   * itself is deleted, since `payment_allocations.payment_id` has a
   * `REFERENCES payments(id)` with no `ON DELETE CASCADE` and would
   * otherwise fail the delete with a FOREIGN KEY constraint error.
   *
   * Returns the distinct gig ids that were affected, so the caller can
   * recompute `amountPaidCents` for each — a gig that loses its only
   * allocation this way must fall back to `null`, and nothing else does
   * that recompute once the payment row is gone.
   */
  async removeAllForPayment(userId: string, paymentId: string): Promise<string[]> {
    const deleted = await this.db
      .delete(paymentAllocations)
      .where(
        and(
          eq(paymentAllocations.userId, userId),
          eq(paymentAllocations.paymentId, paymentId),
        ),
      )
      .returning({ gigId: paymentAllocations.gigId });
    return [...new Set(deleted.map((r) => r.gigId))];
  }

  /**
   * The compatibility path for a legacy client that still sends
   * `PaymentInput.gigId` (routes/payments.ts). Deletes the payment's
   * one existing allocation, if it has one, and writes exactly one for
   * the whole amount — keyed off the payment id rather than any id the
   * caller supplies, so replaying the same payment upsert (an offline
   * outbox retry) always converges on one allocation instead of piling
   * up a second.
   *
   * WHAT IT REFUSES TO DO, and why. A payment that already carries MORE
   * THAN ONE allocation is left completely alone: no delete, no insert,
   * an empty return. The legacy `gigId` is read as "no new information",
   * not as "this payment is, in full, for this one gig now."
   *
   * Every shipped webapp build predates allocations and puts `gigId` on
   * EVERY payment write, so the alternative is not a rare edge case: it
   * is a legacy device editing a payment's notes, or an outbox draining
   * a queue written before the update, silently deleting the split and
   * reassigning the whole payment to whichever gig that device happens
   * to remember. Money moves between gigs and nothing on any screen says
   * so. Reading the field as stale — which is exactly what it is, since
   * a device that can't express a split cannot have authored the split
   * it is overwriting — is the only reading that cannot lose money.
   *
   * The narrower rule "no-op only when the split already totals the
   * payment" was considered and rejected: it still destroys a PARTIAL
   * split (4000+3000 against a 10000 payment — the ordinary state of a
   * payment mid-allocation), which is the same data loss with a smaller
   * blast radius.
   *
   * Rows, not distinct gigs: two allocations against one gig still mean
   * an allocations-aware client wrote this payment, and a legacy payload
   * has no business rewriting either of them.
   *
   * A payment holding exactly one allocation keeps the old behaviour in
   * full — that is the ordinary legacy path (including migration 0016's
   * backfill of every pre-allocations payment), and a legacy client
   * moving its one gig or changing its one amount is information, not
   * staleness.
   *
   * The guard lives here rather than in services/payment-invariants.ts
   * because this method has THREE callers, not two: routes/payments.ts
   * and services/sync.ts share the invariants module, but
   * routes/drafts.ts's confirm-payment does not — it runs its own
   * ownership check and calls straight through. This is the one place
   * every legacy translation funnels through, so it is the one place the
   * guard can't be skipped by a caller that forgets it. The invariant
   * that DEPENDS on the outcome (I4, the shrink-below-allocated
   * refusal, which the compat path used to be exempt from because it
   * resized every allocation) does live in the invariants module, so
   * both doors get it identically.
   *
   * The delete and the insert run as one D1 batch so a failure between
   * them can't leave the payment allocation-less: either both apply or
   * neither does.
   *
   * Returns every gig id that was affected — the gig the payment used to
   * be allocated to, plus the new one — so the caller can recompute
   * `amountPaidCents` for both, including a gig the allocation just
   * moved away from. Empty when a split was preserved: nothing moved, so
   * nothing needs recomputing.
   */
  async replaceSoleAllocation(
    userId: string,
    paymentId: string,
    gigId: string,
    amountCents: number,
    now: number,
  ): Promise<string[]> {
    const previous = await this.db
      .select({ gigId: paymentAllocations.gigId })
      .from(paymentAllocations)
      .where(
        and(
          eq(paymentAllocations.userId, userId),
          eq(paymentAllocations.paymentId, paymentId),
        ),
      );

    if (isSplitPayment(previous.length)) return [];

    await this.db.batch([
      this.db
        .delete(paymentAllocations)
        .where(
          and(
            eq(paymentAllocations.userId, userId),
            eq(paymentAllocations.paymentId, paymentId),
          ),
        ),
      this.db.insert(paymentAllocations).values({
        id: crypto.randomUUID(),
        userId,
        paymentId,
        gigId,
        amountCents,
        createdAt: now,
        modifiedAt: now,
        serverModifiedAt: now,
      }),
    ]);

    return [...new Set([...previous.map((r) => r.gigId), gigId])];
  }
}
