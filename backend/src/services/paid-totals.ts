/**
 * `gigs.amountPaidCents`, derived.
 *
 * The column used to be typed in by hand. It is now the sum of the
 * allocations against the gig, recomputed after every allocation write
 * — which means it is server-owned, exactly like `calendarEventId` and
 * `payments.confirmationR2Key`, and a client that sends one is ignored.
 *
 * Why keep a column at all rather than computing on read: every offline
 * client already reads this field, and a PWA holds its own copy of a
 * gig for as long as it likes. Deriving it on the server and shipping
 * it through the ordinary pull is what lets this change land without a
 * coordinated client release.
 *
 * `serverModifiedAt` is bumped deliberately: it is the watermark other
 * devices pull against, and a total that changes without it is a total
 * they never see.
 */
import { drizzle } from "drizzle-orm/d1";
import { and, eq, inArray, sql } from "drizzle-orm";
import { gigs, paymentAllocations } from "../db/schema.ts";

export async function recomputePaidTotals(
  d1: D1Database,
  userId: string,
  gigIds: readonly string[],
  now: number,
): Promise<void> {
  if (gigIds.length === 0) return;
  const db = drizzle(d1);
  const sums = await db
    .select({
      gigId: paymentAllocations.gigId,
      total: sql<number>`sum(${paymentAllocations.amountCents})`,
    })
    .from(paymentAllocations)
    .where(
      and(
        eq(paymentAllocations.userId, userId),
        inArray(paymentAllocations.gigId, [...gigIds]),
      ),
    )
    .groupBy(paymentAllocations.gigId);

  const byGig = new Map(sums.map((r) => [r.gigId, r.total]));
  for (const gigId of gigIds) {
    await db
      .update(gigs)
      // No allocations left means NULL, not 0: "nothing has been paid"
      // and "we know zero was paid" read the same in a total but not on
      // a screen, and null is what the rest of the app already means by
      // "not set".
      .set({ amountPaidCents: byGig.get(gigId) ?? null, serverModifiedAt: now })
      .where(and(eq(gigs.id, gigId), eq(gigs.userId, userId)));
  }
}
