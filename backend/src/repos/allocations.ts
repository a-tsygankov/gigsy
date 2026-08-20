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
   * The compatibility path for a legacy client that still sends
   * `PaymentInput.gigId` (routes/payments.ts). Deletes whatever
   * allocations already exist for the payment and writes exactly one,
   * for the whole amount, keyed off the payment id rather than any id
   * the caller supplies — so replaying the same payment upsert (an
   * offline outbox retry) always converges on one allocation instead of
   * piling up a second.
   *
   * Returns every gig id that was affected — the gig(s) the payment
   * used to be allocated to, plus the new one — so the caller can
   * recompute `amountPaidCents` for all of them, including a gig the
   * allocation just moved away from.
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

    await this.db
      .delete(paymentAllocations)
      .where(
        and(
          eq(paymentAllocations.userId, userId),
          eq(paymentAllocations.paymentId, paymentId),
        ),
      );

    await this.db.insert(paymentAllocations).values({
      id: crypto.randomUUID(),
      userId,
      paymentId,
      gigId,
      amountCents,
      createdAt: now,
      modifiedAt: now,
      serverModifiedAt: now,
    });

    return [...new Set([...previous.map((r) => r.gigId), gigId])];
  }
}
