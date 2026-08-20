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
import type { UpsertResult } from "../repos/clients.ts";

export type SyncEntity = "client" | "gig" | "expense" | "service" | "payment";

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
  const results: SyncOpResult[] = [];

  for (const op of ops) {
    if (op.op === "delete") {
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
        if (
          parsed.data.gigId != null &&
          (await gigsRepo.get(userId, parsed.data.gigId)) === null
        ) {
          results.push(errored(op.id, "gigId does not reference your gig"));
          break;
        }
        if (
          parsed.data.clientId != null &&
          (await clientsRepo.get(userId, parsed.data.clientId)) === null
        ) {
          results.push(errored(op.id, "clientId does not reference your client"));
          break;
        }
        const existing = await paymentsRepo.get(userId, op.id);
        results.push(
          await lwwUpsert(op.id, op.modifiedAt, existing, () =>
            paymentsRepo.upsert(
              userId,
              op.id,
              {
                gigId: parsed.data.gigId ?? null,
                clientId: parsed.data.clientId ?? null,
                amountCents: parsed.data.amountCents,
                paidAt: parsed.data.paidAt ?? null,
                notes: parsed.data.notes ?? null,
              },
              { now, modifiedAt: op.modifiedAt },
            ),
          ),
        );
        // The allocations translation for a legacy gigId (and the
        // "allocation" sync entity itself) belong to Task 4 of the
        // phase-4 plan, not this task — left untouched here.
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
