/**
 * The invariants a payment write and an allocation write must both
 * satisfy, checked once here instead of twice at the door that happens
 * to be handling the request.
 *
 * Every payment- and allocation-touching write reaches the database
 * through one of two doors: the CRUD route (routes/payments.ts,
 * routes/allocations.ts) or the offline outbox (services/sync.ts,
 * POST /api/sync). Both doors used to run their own copy of these
 * checks, by design — the plan called for byte-identical rejection
 * messages regardless of which door a client used, so neither could
 * become a way to bypass what the other enforces.
 *
 * That duplication had a cost a code review caught directly: a
 * cross-payment allocation move (an existing allocation's `paymentId`
 * AND `gigId` changing in the same write) needs the gig it is
 * *leaving* recomputed, and that gig has to come from the allocation's
 * row as it stood before the write — not from the list of allocations
 * already on the *new* payment, which by definition cannot contain a
 * row that just arrived from somewhere else. Both copies of the
 * recompute logic had this bug the same way, because both were written
 * by mirroring the other. Fixing it in one file did not fix it in the
 * other; fixing it here fixes it once.
 *
 * Each `checkXWrite` function does every DB read the checks need (and
 * a couple more the caller would otherwise have to repeat afterward —
 * the pre-write row, mainly) and returns either the single validation
 * failure that should stop the write, or the small bundle of context
 * the caller needs to actually perform it. The route maps a failure to
 * a 400; sync.ts maps it to an `errored()` result. Both already used
 * these exact messages before this file existed — moving them here
 * changed nothing a caller observes, only where the logic that
 * produces them lives.
 */
import { AllocationsRepo, type AllocationRecord } from "../repos/allocations.ts";
import { GigsRepo } from "../repos/gigs.ts";
import { PaymentsRepo, type PaymentRecord } from "../repos/payments.ts";
import { ClientsRepo } from "../repos/clients.ts";

export interface InvariantViolation {
  ok: false;
  message: string;
}

function violation(message: string): InvariantViolation {
  return { ok: false, message };
}

// ── allocations ──────────────────────────────────────────────────────

export interface AllocationWriteInput {
  paymentId: string;
  gigId: string;
  amountCents: number;
}

export interface AllocationWriteContext {
  ok: true;
  /** The allocation's row before this write, if any — fetched by its
   *  own id (scoped to the caller: `AllocationsRepo.get(userId, id)`,
   *  below), NOT by looking through the payment this write names. That
   *  is what makes it the row's true prior state even when the write is
   *  also moving it to a different payment — `listByPayment` on the new
   *  payment cannot contain a row that is only just arriving there. */
  existing: AllocationRecord | null;
  /** Every gig whose derived total needs recomputing once the write
   *  lands: the gig this allocation now points at, and — if it moved —
   *  the gig it used to point at. Fixed at check time; it does not
   *  depend on the write actually happening, only on whether it's
   *  ABOUT to move a gig, so a caller that skips the write (a stale
   *  LWW op) simply doesn't use this. */
  affectedGigIds: string[];
}

/**
 * Ownership of `paymentId` and `gigId`, the client rule, and
 * over-allocation — every invariant an allocation write (`PUT
 * /api/allocations/:id` or a sync "allocation" op) must satisfy before
 * it touches the database.
 */
export async function checkAllocationWrite(
  d1: D1Database,
  userId: string,
  id: string,
  input: AllocationWriteInput,
): Promise<InvariantViolation | AllocationWriteContext> {
  const paymentsRepo = PaymentsRepo.for(d1);
  const gigsRepo = GigsRepo.for(d1);
  const allocationsRepo = AllocationsRepo.for(d1);

  const payment = await paymentsRepo.get(userId, input.paymentId);
  if (payment === null) {
    return violation("paymentId does not reference your payment");
  }
  const gig = await gigsRepo.get(userId, input.gigId);
  if (gig === null) {
    return violation("gigId does not reference your gig");
  }

  // The client rule: once a payment names a client, every gig it
  // allocates to must belong to that client. A null-client payment
  // allocates freely — the constraint only bites once a client does.
  if (payment.clientId != null && gig.clientId !== payment.clientId) {
    return violation("gigId does not reference the payment's client");
  }

  const existing = await allocationsRepo.get(userId, id);

  // Partial allocation is allowed (a deposit can land before anyone
  // knows which gigs it covers); over-allocation is not. Sum every
  // *other* allocation against this payment — excluding this id, so an
  // update to an existing allocation compares against its own
  // replacement, not its own past value twice.
  const existingForPayment = await allocationsRepo.listByPayment(userId, input.paymentId);
  const othersTotal = existingForPayment
    .filter((a) => a.id !== id)
    .reduce((sum, a) => sum + a.amountCents, 0);
  if (othersTotal + input.amountCents > payment.amountCents) {
    return violation("allocations exceed the payment");
  }

  // See this file's header comment (C1): driven off `existing` — the
  // row's true prior state — not off `existingForPayment`, which is
  // always empty for this row when the write is also moving it onto a
  // different payment.
  const affectedGigIds = new Set([input.gigId]);
  if (existing !== null && existing.gigId !== input.gigId) {
    affectedGigIds.add(existing.gigId);
  }

  return { ok: true, existing, affectedGigIds: [...affectedGigIds] };
}

// ── payments ─────────────────────────────────────────────────────────

export interface PaymentWriteInput {
  gigId?: string | null | undefined;
  clientId?: string | null | undefined;
  amountCents: number;
}

export interface PaymentWriteContext {
  ok: true;
  /** The payment's row before this write, if any. */
  existing: PaymentRecord | null;
}

/**
 * Ownership of `gigId` and `clientId`, the client rule on the legacy
 * `gigId` compat path (I3), refusing to shrink `amountCents` below
 * what is already allocated (I4), and refusing a `clientId` change
 * that would strand existing allocations against a different client's
 * gigs (I5) — every invariant a payment write (`PUT /api/payments/:id`
 * or a sync "payment" op) must satisfy before it touches the database.
 */
export async function checkPaymentWrite(
  d1: D1Database,
  userId: string,
  id: string,
  input: PaymentWriteInput,
): Promise<InvariantViolation | PaymentWriteContext> {
  const gigsRepo = GigsRepo.for(d1);
  const clientsRepo = ClientsRepo.for(d1);
  const paymentsRepo = PaymentsRepo.for(d1);
  const allocationsRepo = AllocationsRepo.for(d1);

  let gig = null as Awaited<ReturnType<typeof gigsRepo.get>>;
  if (input.gigId != null) {
    gig = await gigsRepo.get(userId, input.gigId);
    if (gig === null) {
      return violation("gigId does not reference your gig");
    }
  }
  if (
    input.clientId != null &&
    (await clientsRepo.get(userId, input.clientId)) === null
  ) {
    return violation("clientId does not reference your client");
  }

  const existing = await paymentsRepo.get(userId, id);

  // I3: the client rule the gigId compat path is about to act on. Once
  // the payment names a client — this write's, or the stored one when
  // clientId is absent — every gig it allocates to must belong to that
  // client. Checked before any write, so a rejection leaves nothing
  // half-changed.
  if (input.gigId != null) {
    const effectiveClientId =
      input.clientId !== undefined ? input.clientId : (existing?.clientId ?? null);
    if (effectiveClientId != null && gig!.clientId !== effectiveClientId) {
      return violation("gigId does not reference the payment's client");
    }
  }

  // I4: shrinking a payment below what is already allocated to it
  // would leave those allocations over-claiming money the payment no
  // longer has — the same invariant an allocation write enforces from
  // the other direction. Skipped when this write also carries a
  // gigId: the compat path replaces every existing allocation with one
  // sized to the new amountCents, so there's nothing stale left for
  // this to catch.
  if (input.gigId == null) {
    const currentAllocations = await allocationsRepo.listByPayment(userId, id);
    const allocatedCents = currentAllocations.reduce((sum, a) => sum + a.amountCents, 0);
    if (allocatedCents > input.amountCents) {
      return violation("amountCents is less than the payment's allocated total");
    }
  }

  // I5: changing which client a payment came from, while it already
  // has allocations against gigs belonging to a *different* client,
  // would leave those allocations stale. Rather than silently
  // cascading a delete through someone's money records, this rejects
  // the clientId change outright — the caller has to clear the
  // conflicting allocations first. Narrowing to null is always safe (a
  // null-client payment allocates freely), so only a change to a
  // *different, non-null* client is checked.
  if (
    input.clientId !== undefined &&
    input.clientId != null &&
    existing !== null &&
    existing.clientId !== input.clientId
  ) {
    const currentAllocations = await allocationsRepo.listByPayment(userId, id);
    const allocatedGigIds = [...new Set(currentAllocations.map((a) => a.gigId))];
    const allocatedGigs = await Promise.all(
      allocatedGigIds.map((gigId) => gigsRepo.get(userId, gigId)),
    );
    const conflicts = allocatedGigs.some(
      (g) => g === null || g.clientId !== input.clientId,
    );
    if (conflicts) {
      return violation(
        "clientId does not match one or more gigs this payment is already allocated to",
      );
    }
  }

  return { ok: true, existing };
}
