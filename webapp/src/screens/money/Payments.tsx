/**
 * The payments list.
 *
 * It exists because a payment could previously only be reached through
 * a gig, and Phase 4 made "money received, not yet assigned to work" a
 * legitimate state — a payment with no allocations had no route to it
 * at all.
 */
import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { useData, useSyncState } from "../../lib/app-context.tsx";
import { formatMoney } from "../../lib/format.ts";
import {
  allocationState,
  applyPaymentFilters,
  isPaymentFiltered,
  parsePaymentFilters,
  toPaymentSearchParams,
  type PaymentAllocationState,
} from "../../lib/payment-filters.ts";
import {
  CardLink,
  EmptyState,
  Fab,
  ListSkeleton,
  SyncBadge,
} from "../../components/index.ts";
import { PaymentFilters } from "./PaymentFilters.tsx";

const STATE_LABEL: Record<PaymentAllocationState, string> = {
  unallocated: "Not yet allocated",
  partly: "Partly allocated",
  fully: "Allocated",
};

const STATE_CLASS: Record<PaymentAllocationState, string> = {
  unallocated: "text-amber-700",
  partly: "text-amber-700",
  fully: "text-slate-500",
};

function dateLine(paidAt: number | null): string {
  return paidAt === null ? "No date yet" : new Date(paidAt).toLocaleDateString();
}

export function Payments() {
  const api = useData();
  const payments = useQuery({ queryKey: ["payments"], queryFn: () => api.listPayments() });
  const allocations = useQuery({
    queryKey: ["allocations"],
    queryFn: () => api.listAllocations(),
  });
  const clients = useQuery({ queryKey: ["clients"], queryFn: () => api.listClients() });

  const sync = useSyncState();
  const queryClient = useQueryClient();
  const pending = useQuery({
    queryKey: ["pending-payment-ids"],
    queryFn: () => api.pendingPaymentIds(),
    // The outbox is local and cheap to read, and a stale answer here
    // marks the wrong payment.
    staleTime: 0,
  });

  // The count is a size, not a revision — keying the query on it
  // re-serves a cached id set whenever the count returns to a value it
  // held before, leaving the dot on a payment that already synced.
  // Gigs.tsx carries this same effect for the same reason.
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: ["pending-payment-ids"] });
  }, [sync?.pendingCount, queryClient]);

  // In the URL, not in state: a filter that evaporates the moment you
  // open a payment and come back is not worth setting. Same reasoning
  // as the gig list.
  const [params, setParams] = useSearchParams();
  const filters = parsePaymentFilters(params);

  const allocatedByPayment = new Map<string, number>();
  for (const allocation of allocations.data ?? []) {
    allocatedByPayment.set(
      allocation.paymentId,
      (allocatedByPayment.get(allocation.paymentId) ?? 0) + allocation.amountCents,
    );
  }
  const clientNameById = new Map(clients.data?.map((c) => [c.id, c.name]) ?? []);

  const all = payments.data ?? [];
  const rows = applyPaymentFilters(all, allocatedByPayment, clientNameById, filters);

  const loading = payments.isPending || allocations.isPending;
  const failed = payments.isError || allocations.isError;

  return (
    <>
      <PaymentFilters
        filters={filters}
        onChange={(next) => setParams(toPaymentSearchParams(next), { replace: true })}
        shown={rows.length}
        total={all.length}
      />

      {loading && <ListSkeleton />}
      {failed && <p className="text-sm text-red-600">Couldn't load payments.</p>}

      {!loading && !failed && all.length === 0 && (
        <EmptyState
          title="No payments yet"
          hint="Record money as it arrives — you can say which work it paid for now or later."
          cta="Record a payment"
          to="/payments/new"
        />
      )}

      {!loading && !failed && all.length > 0 && rows.length === 0 && (
        <EmptyState
          title="No payment matches this filter"
          {...(isPaymentFiltered(filters)
            ? { hint: "Clear the filter to see all of them." }
            : {})}
        />
      )}

      {rows.length > 0 && (
        <div className="space-y-3" data-testid="payment-list">
          {rows.map((payment) => {
            const state = allocationState(
              payment.amountCents,
              allocatedByPayment.get(payment.id) ?? 0,
            );
            const clientName =
              payment.clientId === null ? null : clientNameById.get(payment.clientId) ?? null;
            return (
              <CardLink
                key={payment.id}
                to={`/payments/${payment.id}`}
                data-testid="payment-row"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-slate-900">
                      {clientName ?? "No client yet"}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {dateLine(payment.paidAt)}
                      {" · "}
                      <span className={STATE_CLASS[state]}>{STATE_LABEL[state]}</span>
                    </p>
                    {pending.data?.has(payment.id) === true && (
                      <span data-testid="payment-pending" className="mt-1 inline-block">
                        <SyncBadge online={sync?.online ?? true} pendingCount={1} />
                      </span>
                    )}
                  </div>
                  <span className="shrink-0 text-sm font-semibold text-slate-800">
                    {formatMoney(payment.amountCents)}
                  </span>
                </div>
              </CardLink>
            );
          })}
        </div>
      )}

      <Fab to="/payments/new" label="Record payment" testId="payment-add" />
    </>
  );
}
