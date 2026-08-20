/**
 * Offline outbox drain (docs/plan.md §7): idempotent, per-op results,
 * last-write-wins by the client's modifiedAt. Retried batches from
 * flaky connections converge instead of duplicating; a failing op
 * never aborts the rest of the batch.
 *
 * Timestamps: created_at is server time; modified_at stores the
 * CLIENT's edit time — it is the LWW conflict signal across devices,
 * so the edit moment (not the upload moment) must win ties.
 */
import {
  AllocationInput,
  ClientInput,
  ExpenseInput,
  GigInput,
  PaymentInput,
  ServiceInput,
} from "../domain/schemas.ts";
import { ClientsRepo } from "../repos/clients.ts";
import { ExpensesRepo } from "../repos/expenses.ts";
import { GigsRepo } from "../repos/gigs.ts";
import { PaymentsRepo } from "../repos/payments.ts";
import { ServicesRepo } from "../repos/services.ts";
import { AllocationsRepo } from "../repos/allocations.ts";
import { recomputePaidTotals } from "./paid-totals.ts";
import type { UpsertResult } from "../repos/clients.ts";

export type SyncEntity =
  | "client"
  | "gig"
  | "expense"
  | "service"
  | "payment"
  | "allocation";

export interface SyncOpBase {
  entity: SyncEntity;
  id: string;
  /** Client edit time, epoch ms. */
  modifiedAt: number;
}
export interface SyncUpsertOp extends SyncOpBase {
  op: "upsert";
  payload: unknown;
}
export interface SyncDeleteOp extends SyncOpBase {
  op: "delete";
}
export type SyncOp = SyncUpsertOp | SyncDeleteOp;

export interface SyncOpResult {
  id: string;
  status: "applied" | "skipped" | "error";
  reason?: string;
}

const applied = (id: string): SyncOpResult => ({ id, status: "applied" });
const skipped = (id: string, reason: string): SyncOpResult => ({
  id,
  status: "skipped",
  reason,
});
const errored = (id: string, reason: string): SyncOpResult => ({
  id,
  status: "error",
  reason,
});

/** Shared LWW skeleton: stale-check against the caller's own row,
 * then upsert (which itself rejects foreign-owned ids). */
async function lwwUpsert(
  id: string,
  incomingModifiedAt: number,
  existing: { modifiedAt: number } | null,
  run: () => Promise<UpsertResult<unknown>>,
): Promise<SyncOpResult> {
  if (existing !== null && incomingModifiedAt < existing.modifiedAt) {
    return skipped(id, `stale: server copy is newer (${existing.modifiedAt})`);
  }
  const result = await run();
  if (result === "forbidden") return errored(id, "not found");
  return applied(id);
}

export async function applySyncOps(
  d1: D1Database,
  userId: string,
  ops: SyncOp[],
  now: number,
): Promise<SyncOpResult[]> {
  const clientsRepo = ClientsRepo.for(d1);
  const gigsRepo = GigsRepo.for(d1);
  const expensesRepo = ExpensesRepo.for(d1);
  const servicesRepo = ServicesRepo.for(d1);
  const paymentsRepo = PaymentsRepo.for(d1);
  const allocationsRepo = AllocationsRepo.for(d1);
  const results: SyncOpResult[] = [];

  for (const op of ops) {
    if (op.op === "delete") {
      // A payment can't go through the generic path below:
      // payment_allocations.payment_id references payments(id) with no
      // ON DELETE CASCADE, so deleting a payment that still has
      // allocations (which, after migration 0016's backfill, is every
      // payment that ever named a gig) fails the delete with a FOREIGN
      // KEY constraint error and leaves the gig's derived total stale.
      // Same fix as routes/payments.ts's DELETE handler, mirrored here
      // because the outbox drains through this path too.
      if (op.entity === "payment") {
        const affectedGigIds = await allocationsRepo.removeAllForPayment(userId, op.id);
        const removed = await paymentsRepo.remove(userId, op.id);
        if (removed && affectedGigIds.length > 0) {
          await recomputePaidTotals(d1, userId, affectedGigIds, now);
        }
        results.push(removed ? applied(op.id) : skipped(op.id, "not found"));
        continue;
      }
      // An allocation delete must recompute the gig's derived total, and
      // the gigId it recomputes against has to be read before the row is
      // gone — there is nothing left to look it up from afterward.
      if (op.entity === "allocation") {
        const existingAllocation = await allocationsRepo.get(userId, op.id);
        const removed = await allocationsRepo.remove(userId, op.id);
        if (removed && existingAllocation !== null) {
          await recomputePaidTotals(d1, userId, [existingAllocation.gigId], now);
        }
        results.push(removed ? applied(op.id) : skipped(op.id, "not found"));
        continue;
      }
      const repo = {
        client: clientsRepo,
        gig: gigsRepo,
        expense: expensesRepo,
        service: servicesRepo,
        payment: paymentsRepo,
      }[op.entity];
      const removed = await repo.remove(userId, op.id);
      results.push(removed ? applied(op.id) : skipped(op.id, "not found"));
      continue;
    }

    switch (op.entity) {
      case "client": {
        const parsed = ClientInput.safeParse(op.payload);
        if (!parsed.success) {
          results.push(errored(op.id, "invalid payload"));
          break;
        }
        const existing = await clientsRepo.get(userId, op.id);
        results.push(
          await lwwUpsert(op.id, op.modifiedAt, existing, () =>
            clientsRepo.upsert(
              userId,
              op.id,
              {
                name: parsed.data.name,
                contactInfo: parsed.data.contactInfo ?? null,
                notes: parsed.data.notes ?? null,
              },
              { now, modifiedAt: op.modifiedAt },
            ),
          ),
        );
        break;
      }
      case "gig": {
        const parsed = GigInput.safeParse(op.payload);
        if (!parsed.success) {
          results.push(errored(op.id, "invalid payload"));
          break;
        }
        if (
          parsed.data.clientId != null &&
          (await clientsRepo.get(userId, parsed.data.clientId)) === null
        ) {
          results.push(errored(op.id, "clientId does not reference your client"));
          break;
        }
        const existing = await gigsRepo.get(userId, op.id);
        results.push(
          await lwwUpsert(op.id, op.modifiedAt, existing, () =>
            gigsRepo.upsert(
              userId,
              op.id,
              {
                clientId: parsed.data.clientId ?? null,
                title: parsed.data.title ?? null,
                status: parsed.data.status,
                location: parsed.data.location ?? null,
                dateTime: parsed.data.dateTime ?? null,
                durationMinutes: parsed.data.durationMinutes ?? null,
                payType: parsed.data.payType,
                hourlyRateCents: parsed.data.hourlyRateCents ?? null,
                workStartedAt: parsed.data.workStartedAt ?? null,
                workEndedAt: parsed.data.workEndedAt ?? null,
                breakMinutes: parsed.data.breakMinutes ?? null,
                amountOfferedCents: parsed.data.amountOfferedCents ?? null,
                amountPaidCents: parsed.data.amountPaidCents ?? null,
                notes: parsed.data.notes ?? null,
                source: parsed.data.source,
              },
              { now, modifiedAt: op.modifiedAt },
            ),
          ),
        );
        break;
      }
      case "service": {
        const parsed = ServiceInput.safeParse(op.payload);
        if (!parsed.success) {
          results.push(errored(op.id, "invalid payload"));
          break;
        }
        if ((await gigsRepo.get(userId, parsed.data.gigId)) === null) {
          results.push(errored(op.id, "gigId does not reference your gig"));
          break;
        }
        if (
          parsed.data.paymentId != null &&
          (await paymentsRepo.get(userId, parsed.data.paymentId)) === null
        ) {
          results.push(errored(op.id, "paymentId does not reference your payment"));
          break;
        }
        const existing = await servicesRepo.get(userId, op.id);
        results.push(
          await lwwUpsert(op.id, op.modifiedAt, existing, () =>
            servicesRepo.upsert(
              userId,
              op.id,
              {
                gigId: parsed.data.gigId,
                description: parsed.data.description,
                amountOfferedCents: parsed.data.amountOfferedCents ?? null,
                amountPaidCents: parsed.data.amountPaidCents ?? null,
                paymentId: parsed.data.paymentId ?? null,
                isCompleted: parsed.data.isCompleted,
              },
              { now, modifiedAt: op.modifiedAt },
            ),
          ),
        );
        break;
      }
      case "payment": {
        const parsed = PaymentInput.safeParse(op.payload);
        if (!parsed.success) {
          results.push(errored(op.id, "invalid payload"));
          break;
        }
        let gig: Awaited<ReturnType<typeof gigsRepo.get>> = null;
        if (parsed.data.gigId != null) {
          gig = await gigsRepo.get(userId, parsed.data.gigId);
          if (gig === null) {
            results.push(errored(op.id, "gigId does not reference your gig"));
            break;
          }
        }
        if (
          parsed.data.clientId != null &&
          (await clientsRepo.get(userId, parsed.data.clientId)) === null
        ) {
          results.push(errored(op.id, "clientId does not reference your client"));
          break;
        }
        const existing = await paymentsRepo.get(userId, op.id);

        // I3 (routes/payments.ts, carried here): the client rule the
        // gigId compat path below is about to act on. Once the payment
        // names a client — this op's, or the stored one when clientId
        // is absent — every gig it allocates to must belong to that
        // client. Checked before any write: the offline path is the
        // same client hitting a different door, and a check the route
        // enforces but sync doesn't is a check that door can skip.
        if (parsed.data.gigId != null) {
          const effectiveClientId =
            parsed.data.clientId !== undefined
              ? parsed.data.clientId
              : (existing?.clientId ?? null);
          if (effectiveClientId != null && gig!.clientId !== effectiveClientId) {
            results.push(errored(op.id, "gigId does not reference the payment's client"));
            break;
          }
        }

        // I4 (routes/payments.ts, carried here): shrinking a payment
        // below what is already allocated to it would leave those
        // allocations over-claiming money the payment no longer has.
        // Skipped when gigId is present, same as the route — the
        // compat path below replaces every existing allocation with one
        // sized to the new amountCents, so there's nothing stale left
        // for this to catch.
        if (parsed.data.gigId == null) {
          const currentAllocations = await allocationsRepo.listByPayment(userId, op.id);
          const allocatedCents = currentAllocations.reduce(
            (sum, a) => sum + a.amountCents,
            0,
          );
          if (allocatedCents > parsed.data.amountCents) {
            results.push(
              errored(op.id, "amountCents is less than the payment's allocated total"),
            );
            break;
          }
        }

        // I5 (routes/payments.ts, carried here): changing a payment's
        // clientId to a different, non-null client while it already has
        // allocations against another client's gigs would leave those
        // allocations stale. Rejected rather than silently cascaded, so
        // the caller resolves the conflict first — narrowing to null
        // stays unrestricted, since a null-client payment allocates
        // freely.
        if (
          parsed.data.clientId !== undefined &&
          parsed.data.clientId != null &&
          existing !== null &&
          existing.clientId !== parsed.data.clientId
        ) {
          const currentAllocations = await allocationsRepo.listByPayment(userId, op.id);
          const allocatedGigIds = [...new Set(currentAllocations.map((a) => a.gigId))];
          const allocatedGigs = await Promise.all(
            allocatedGigIds.map((gigId) => gigsRepo.get(userId, gigId)),
          );
          const conflicts = allocatedGigs.some(
            (g) => g === null || g.clientId !== parsed.data.clientId,
          );
          if (conflicts) {
            results.push(
              errored(
                op.id,
                "clientId does not match one or more gigs this payment is already allocated to",
              ),
            );
            break;
          }
        }

        const result = await lwwUpsert(op.id, op.modifiedAt, existing, () =>
          paymentsRepo.upsert(
            userId,
            op.id,
            {
              gigId: parsed.data.gigId ?? null,
              // Not `?? null`: absent (undefined) must preserve the
              // stored value rather than wipe it — see
              // repos/payments.ts's PaymentData.clientId doc comment.
              clientId: parsed.data.clientId,
              amountCents: parsed.data.amountCents,
              paidAt: parsed.data.paidAt ?? null,
              notes: parsed.data.notes ?? null,
            },
            { now, modifiedAt: op.modifiedAt },
          ),
        );
        results.push(result);

        // The legacy gigId compat path (Task 4 of the phase-4 plan): a
        // client that queued this op before the allocations release
        // still sends PaymentInput.gigId. Translated into a single
        // allocation here exactly as routes/payments.ts does for a
        // direct write — this is the outbox's own drain, so skipping it
        // here is what used to leave a queued legacy payment with no
        // allocation at all, silently dropping its contribution the
        // next time some other allocation change recomputed the gig's
        // total. replaceSoleAllocation is keyed off the payment id, not
        // any id the client supplies, so replaying the same op
        // converges on one allocation instead of adding a second.
        //
        // Only runs when the upsert actually applied: a stale
        // (LWW-skipped) or errored op must not resurrect or rewrite an
        // allocation that a newer op already moved past.
        if (result.status === "applied" && parsed.data.gigId != null) {
          const affectedGigIds = await allocationsRepo.replaceSoleAllocation(
            userId,
            op.id,
            parsed.data.gigId,
            parsed.data.amountCents,
            now,
          );
          await recomputePaidTotals(d1, userId, affectedGigIds, now);
        }
        break;
      }
      case "allocation": {
        const parsed = AllocationInput.safeParse(op.payload);
        if (!parsed.success) {
          results.push(errored(op.id, "invalid payload"));
          break;
        }
        const payment = await paymentsRepo.get(userId, parsed.data.paymentId);
        if (payment === null) {
          results.push(errored(op.id, "paymentId does not reference your payment"));
          break;
        }
        const gig = await gigsRepo.get(userId, parsed.data.gigId);
        if (gig === null) {
          results.push(errored(op.id, "gigId does not reference your gig"));
          break;
        }

        // The client rule (routes/allocations.ts, carried here): once a
        // payment names a client, every gig it allocates to must belong
        // to that client. A null-client payment allocates freely.
        if (payment.clientId != null && gig.clientId !== payment.clientId) {
          results.push(errored(op.id, "gigId does not reference the payment's client"));
          break;
        }

        const existing = await allocationsRepo.get(userId, op.id);

        // Over-allocation (routes/allocations.ts, carried here): sum
        // every *other* allocation against this payment — excluding
        // this id, so an update compares against its own replacement,
        // not its own past value twice. Partial allocation is fine; a
        // total over the payment's amount is not.
        const existingForPayment = await allocationsRepo.listByPayment(
          userId,
          parsed.data.paymentId,
        );
        const priorSelf = existingForPayment.find((a) => a.id === op.id);
        const othersTotal = existingForPayment
          .filter((a) => a.id !== op.id)
          .reduce((sum, a) => sum + a.amountCents, 0);
        if (othersTotal + parsed.data.amountCents > payment.amountCents) {
          results.push(errored(op.id, "allocations exceed the payment"));
          break;
        }

        const result = await lwwUpsert(op.id, op.modifiedAt, existing, () =>
          allocationsRepo.upsert(
            userId,
            op.id,
            {
              paymentId: parsed.data.paymentId,
              gigId: parsed.data.gigId,
              amountCents: parsed.data.amountCents,
            },
            { now, modifiedAt: op.modifiedAt },
          ),
        );
        results.push(result);

        // Recompute the gig this allocation now points at, and — if it
        // moved — the gig it used to point at too, so neither total is
        // left stale. Same as routes/allocations.ts. Skipped for a
        // stale/errored op: nothing was written, so nothing changed.
        if (result.status === "applied") {
          const affectedGigIds = new Set([parsed.data.gigId]);
          if (priorSelf !== undefined && priorSelf.gigId !== parsed.data.gigId) {
            affectedGigIds.add(priorSelf.gigId);
          }
          await recomputePaidTotals(d1, userId, [...affectedGigIds], now);
        }
        break;
      }
      case "expense": {
        const parsed = ExpenseInput.safeParse(op.payload);
        if (!parsed.success) {
          results.push(errored(op.id, "invalid payload"));
          break;
        }
        if (
          parsed.data.gigId != null &&
          (await gigsRepo.get(userId, parsed.data.gigId)) === null
        ) {
          results.push(errored(op.id, "gigId does not reference your gig"));
          break;
        }
        const existing = await expensesRepo.get(userId, op.id);
        results.push(
          await lwwUpsert(op.id, op.modifiedAt, existing, () =>
            expensesRepo.upsert(
              userId,
              op.id,
              {
                gigId: parsed.data.gigId ?? null,
                amountCents: parsed.data.amountCents,
                category: parsed.data.category ?? null,
                receiptR2Key: parsed.data.receiptR2Key ?? null,
                notes: parsed.data.notes ?? null,
                reimbursable: parsed.data.reimbursable,
              },
              { now, modifiedAt: op.modifiedAt },
            ),
          ),
        );
        break;
      }
    }
  }

  return results;
}
