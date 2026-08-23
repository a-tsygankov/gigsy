import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAYMENT_FILTERS,
  allocationState,
  applyPaymentFilters,
  isPaymentFiltered,
  parsePaymentFilters,
  toPaymentSearchParams,
  type PaymentFilters,
} from "./payment-filters.ts";
import type { Payment } from "./types.ts";

function payment(over: Partial<Payment> = {}): Payment {
  return {
    id: "p1",
    gigId: null,
    clientId: "c1",
    amountCents: 15000,
    paidAt: Date.UTC(2026, 8, 10, 12),
    confirmationR2Key: null,
    notes: null,
    createdAt: Date.UTC(2026, 8, 10, 12),
    modifiedAt: Date.UTC(2026, 8, 10, 12),
    ...over,
  };
}

const CLIENTS = new Map([
  ["c1", "Acme Staffing"],
  ["c2", "Pier Events"],
]);

function filters(over: Partial<PaymentFilters> = {}): PaymentFilters {
  return { ...DEFAULT_PAYMENT_FILTERS, ...over };
}

describe("allocationState", () => {
  it("calls a payment with nothing against it unallocated", () => {
    expect(allocationState(15000, 0)).toBe("unallocated");
  });

  it("treats a zero-sum set of allocations as unallocated, not partly", () => {
    // A row can exist with 0 cents mid-edit; it is not a claim on the money.
    expect(allocationState(15000, 0)).toBe("unallocated");
  });

  it("calls a covered payment fully allocated", () => {
    expect(allocationState(15000, 15000)).toBe("fully");
  });

  it("calls anything in between partly allocated", () => {
    expect(allocationState(15000, 10000)).toBe("partly");
    expect(allocationState(15000, 1)).toBe("partly");
    expect(allocationState(15000, 14999)).toBe("partly");
  });

  it("treats an over-allocated payment as fully rather than inventing a state", () => {
    // The server refuses this ("allocations exceed the payment"), but a
    // half-synced pair can sit in Dexie for a moment. A list is not the
    // place to raise it.
    expect(allocationState(15000, 20000)).toBe("fully");
  });

  it("calls a zero-amount payment fully allocated rather than dividing by it", () => {
    expect(allocationState(0, 0)).toBe("fully");
  });
});

describe("applyPaymentFilters", () => {
  const a = payment({ id: "a", amountCents: 15000, clientId: "c1" });
  const b = payment({ id: "b", amountCents: 5000, clientId: "c2", notes: "invoice 88" });
  const c = payment({ id: "c", amountCents: 2500, clientId: null, notes: null });
  const all = [a, b, c];
  const allocated = new Map([
    ["a", 15000], // fully
    ["b", 2000], // partly
    // c absent → unallocated
  ]);

  it("returns everything when unfiltered", () => {
    const rows = applyPaymentFilters(all, allocated, CLIENTS, filters());
    expect(rows.map((p) => p.id)).toEqual(["a", "b", "c"]);
  });

  it("filters to unallocated, including a payment with no allocation row at all", () => {
    const rows = applyPaymentFilters(all, allocated, CLIENTS, filters({ state: "unallocated" }));
    expect(rows.map((p) => p.id)).toEqual(["c"]);
  });

  it("filters to partly allocated", () => {
    const rows = applyPaymentFilters(all, allocated, CLIENTS, filters({ state: "partly" }));
    expect(rows.map((p) => p.id)).toEqual(["b"]);
  });

  it("filters to fully allocated", () => {
    const rows = applyPaymentFilters(all, allocated, CLIENTS, filters({ state: "fully" }));
    expect(rows.map((p) => p.id)).toEqual(["a"]);
  });

  it("searches notes", () => {
    const rows = applyPaymentFilters(all, allocated, CLIENTS, filters({ search: "invoice" }));
    expect(rows.map((p) => p.id)).toEqual(["b"]);
  });

  it("searches the client's name, which is not on the payment itself", () => {
    const rows = applyPaymentFilters(all, allocated, CLIENTS, filters({ search: "pier" }));
    expect(rows.map((p) => p.id)).toEqual(["b"]);
  });

  it("searches the amount as it is written, so 150 finds 150.00", () => {
    const rows = applyPaymentFilters(all, allocated, CLIENTS, filters({ search: "150" }));
    expect(rows.map((p) => p.id)).toEqual(["a"]);
  });

  it("does not let 1.50 match 150.00", () => {
    const rows = applyPaymentFilters(all, allocated, CLIENTS, filters({ search: "1.50" }));
    expect(rows).toEqual([]);
  });

  it("ignores case and surrounding whitespace", () => {
    const rows = applyPaymentFilters(all, allocated, CLIENTS, filters({ search: "  ACME " }));
    expect(rows.map((p) => p.id)).toEqual(["a"]);
  });

  it("survives a payment with no notes and no client", () => {
    const rows = applyPaymentFilters([c], allocated, CLIENTS, filters({ search: "acme" }));
    expect(rows).toEqual([]);
  });

  it("combines search and state rather than treating them as alternatives", () => {
    const rows = applyPaymentFilters(
      all,
      allocated,
      CLIENTS,
      filters({ search: "invoice", state: "fully" }),
    );
    expect(rows).toEqual([]);
  });

  it("orders newest first by paidAt, falling back to createdAt when undated", () => {
    const older = payment({ id: "older", paidAt: Date.UTC(2026, 0, 1) });
    const newer = payment({ id: "newer", paidAt: Date.UTC(2026, 11, 1) });
    const undated = payment({ id: "undated", paidAt: null, createdAt: Date.UTC(2026, 5, 1) });
    const rows = applyPaymentFilters([older, undated, newer], new Map(), CLIENTS, filters());
    expect(rows.map((p) => p.id)).toEqual(["newer", "undated", "older"]);
  });
});

describe("URL round-trip", () => {
  it("writes nothing for an unfiltered view", () => {
    expect(toPaymentSearchParams(DEFAULT_PAYMENT_FILTERS).toString()).toBe("");
  });

  it("round-trips a filtered view", () => {
    const f = filters({ search: "acme", state: "unallocated" });
    expect(parsePaymentFilters(toPaymentSearchParams(f))).toEqual(f);
  });

  it("falls back to the default for an unknown state rather than showing nothing", () => {
    const parsed = parsePaymentFilters(new URLSearchParams("state=banana"));
    expect(parsed.state).toBe("all");
  });

  it("knows when a view is filtered", () => {
    expect(isPaymentFiltered(DEFAULT_PAYMENT_FILTERS)).toBe(false);
    expect(isPaymentFiltered(filters({ search: "  " }))).toBe(false);
    expect(isPaymentFiltered(filters({ search: "x" }))).toBe(true);
    expect(isPaymentFiltered(filters({ state: "partly" }))).toBe(true);
  });
});
