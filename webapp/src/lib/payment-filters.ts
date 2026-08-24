/**
 * The payment list's filtering, kept away from the screen so it can be
 * tested without one — the same split `gig-filters.ts` uses.
 *
 * Allocation state is DERIVED. Nothing stores it: a payment's state is
 * its amount measured against the sum of the allocations pointing at
 * it, and both halves move independently.
 */
import type { Payment } from "./types.ts";

export const PAYMENT_STATES = ["unallocated", "partly", "fully"] as const;
export type PaymentAllocationState = (typeof PAYMENT_STATES)[number];

/** `all` is the absence of a state filter, not a fourth state. */
export type PaymentStateFilter = "all" | PaymentAllocationState;

export interface PaymentFilters {
  search: string;
  state: PaymentStateFilter;
}

export const DEFAULT_PAYMENT_FILTERS: PaymentFilters = {
  search: "",
  state: "all",
};

/**
 * A payment measured against what has been allocated out of it.
 *
 * Over-allocation collapses into `fully` rather than becoming a fourth
 * state: the server refuses it (`payment-invariants.ts`, "allocations
 * exceed the payment"), so the only way to see one is a half-synced
 * pair sitting in Dexie for a moment, and a list is the wrong place to
 * raise that. A zero-amount payment is `fully` for the same reason —
 * there is nothing left to allocate.
 */
export function allocationState(
  amountCents: number,
  allocatedCents: number,
): PaymentAllocationState {
  if (allocatedCents <= 0) return amountCents <= 0 ? "fully" : "unallocated";
  if (allocatedCents >= amountCents) return "fully";
  return "partly";
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * The amount as it is written, not as it is stored: `toFixed(2)` gives
 * "150.00", so typing 150 finds it and typing 1.50 does not. Matching
 * the raw cents would make 150 match a $1.50 payment, which is the
 * opposite of what someone reading a bank statement means.
 */
function amountNeedle(amountCents: number): string {
  return (amountCents / 100).toFixed(2);
}

function matchesSearch(
  payment: Payment,
  clientName: string | undefined,
  needle: string,
): boolean {
  if (needle === "") return true;
  const haystacks = [
    payment.notes ?? "",
    clientName ?? "",
    amountNeedle(payment.amountCents),
  ];
  return haystacks.some((h) => normalize(h).includes(needle));
}

/** Newest first. `paidAt` is the date a person means; an undated
 *  payment falls back to when it was recorded rather than sinking to
 *  the bottom, because it is usually the one that needs attention. */
function sortKey(payment: Payment): number {
  return payment.paidAt ?? payment.createdAt;
}

export function applyPaymentFilters(
  payments: readonly Payment[],
  allocatedByPayment: ReadonlyMap<string, number>,
  clientNameById: ReadonlyMap<string, string>,
  filters: PaymentFilters,
): Payment[] {
  const needle = normalize(filters.search);
  return payments
    .filter((payment) => {
      if (filters.state !== "all") {
        const allocated = allocatedByPayment.get(payment.id) ?? 0;
        if (allocationState(payment.amountCents, allocated) !== filters.state) {
          return false;
        }
      }
      const clientName =
        payment.clientId === null ? undefined : clientNameById.get(payment.clientId);
      return matchesSearch(payment, clientName, needle);
    })
    .sort((a, b) => sortKey(b) - sortKey(a));
}

/** Sort is not a filter: reordering hides nothing. Mirrors the same
 *  reasoning in `gig-filters.ts`'s `isFiltered`. */
export function isPaymentFiltered(filters: PaymentFilters): boolean {
  return normalize(filters.search) !== "" || filters.state !== "all";
}

function isPaymentStateFilter(value: string | null): value is PaymentStateFilter {
  return (
    value !== null && (value === "all" || (PAYMENT_STATES as readonly string[]).includes(value))
  );
}

export function parsePaymentFilters(params: URLSearchParams): PaymentFilters {
  const state = params.get("state");
  return {
    search: params.get("q") ?? DEFAULT_PAYMENT_FILTERS.search,
    state: isPaymentStateFilter(state) ? state : DEFAULT_PAYMENT_FILTERS.state,
  };
}

/**
 * Defaults are written as absence, so an unfiltered list has a clean
 * URL and the back button has nothing pointless to remember.
 *
 * The guard is on the NORMALIZED search, not the raw one: whitespace
 * alone is not a filter (`isPaymentFiltered` agrees), so it must not
 * write a `q` param either, or the view becomes impossible to clear —
 * every reparse hands back the same untrimmed value, which
 * `isPaymentFiltered` still reads as unfiltered. The value written when
 * it DOES qualify is still the raw string, so mid-typing whitespace
 * (leading/trailing spaces around real text) round-trips exactly.
 */
export function toPaymentSearchParams(filters: PaymentFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (normalize(filters.search) !== "") params.set("q", filters.search);
  if (filters.state !== DEFAULT_PAYMENT_FILTERS.state) params.set("state", filters.state);
  return params;
}
