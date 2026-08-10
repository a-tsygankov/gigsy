/**
 * Browser/device push subscriptions (Phase 10).
 *
 * Keyed by the push service's own endpoint, so a browser that
 * re-subscribes replaces its row instead of accumulating duplicates —
 * re-subscription is routine (permission changes, key rotation, the
 * service expiring one), not exceptional.
 *
 * A 404/410 from the push service means the subscription is dead and
 * the row is removed. That pruning path is deliberate: the calendar
 * connection taught us that a stored credential with no way to be
 * cleared fails silently forever.
 */
import { and, eq } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { pushSubscriptions } from "../db/schema.ts";

export type PushSubscriptionRecord = typeof pushSubscriptions.$inferSelect;

export interface PushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export class PushSubscriptionsRepo {
  constructor(private readonly db: DrizzleD1Database) {}

  static for(d1: D1Database): PushSubscriptionsRepo {
    return new PushSubscriptionsRepo(drizzle(d1));
  }

  /** Idempotent by endpoint — the browser may re-send the same one. */
  async save(
    userId: string,
    input: PushSubscriptionInput,
    now: number,
  ): Promise<void> {
    await this.db
      .insert(pushSubscriptions)
      .values({ ...input, userId, createdAt: now })
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        // The keys rotate with the subscription, and an endpoint can
        // be reassigned to another user on a shared device.
        set: { userId, p256dh: input.p256dh, auth: input.auth, createdAt: now },
      });
  }

  list(userId: string): Promise<PushSubscriptionRecord[]> {
    return this.db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId));
  }

  /** Used both by an explicit opt-out and by pruning a dead endpoint. */
  async remove(userId: string, endpoint: string): Promise<void> {
    await this.db
      .delete(pushSubscriptions)
      .where(
        and(
          eq(pushSubscriptions.endpoint, endpoint),
          eq(pushSubscriptions.userId, userId),
        ),
      );
  }

  /** Pruning from the sender, which knows the endpoint but is already
   * iterating a specific user's rows. */
  async removeByEndpoint(endpoint: string): Promise<void> {
    await this.db
      .delete(pushSubscriptions)
      .where(eq(pushSubscriptions.endpoint, endpoint));
  }
}
