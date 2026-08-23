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
    // A zero-sum set of allocation rows is the same input as no rows at
    // all here — the signature is a plain number, so that distinction
    // is expressed one level up, in applyPaymentFilters's fixture `d`.
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
  // Explicit zero, not an absent row — a distinct input from c's, even
  // though allocationState can't tell them apart at its own signature.
  const d = payment({ id: "d", amountCents: 4000, clientId: null });
  const all = [a, b, c, d];
  const allocated = new Map([
    ["a", 15000], // fully
    ["b", 2000], // partly
    ["d", 0], // unallocated — a real row that sums to zero
    // c absent → unallocated
  ]);

  it("returns everything when unfiltered", () => {
    const rows = applyPaymentFilters(all, allocated, CLIENTS, filters());
    expect(rows.map((p) => p.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("filters to unallocated, treating a zero-sum row the same as no row at all", () => {
    const rows = applyPaymentFilters(all, allocated, CLIENTS, filters({ state: "unallocated" }));
    expect(rows.map((p) => p.id)).toEqual(["c", "d"]);
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

  it("does not let a search for 150 match a $1.50 payment", () => {
    // The discriminating case: matching raw cents (as `String(amountCents)`
    // would) makes 150 find a 150-cent payment, which is the opposite of
    // what someone reading a dollar amount means. Formatting to "1.50"
    // first is what keeps it out.
    const tiny = payment({ id: "tiny", amountCents: 150 });
    const rows = applyPaymentFilters([tiny], new Map(), CLIENTS, filters({ search: "150" }));
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

  it("treats a clientId the client map doesn't know yet as no name, not a throw", () => {
    // Offline-first: a payment can sync before its client does. The
    // clientId is real, just not in the map — a different code path
    // from clientId being null outright.
    const orphaned = payment({ id: "orphaned", clientId: "not-yet-synced", notes: null });
    const rows = applyPaymentFilters([orphaned], new Map(), CLIENTS, filters({ search: "acme" }));
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

  it("does not mutate the array it was given", () => {
    const input = [...all];
    applyPaymentFilters(input, allocated, CLIENTS, filters());
    expect(input.map((p) => p.id)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("URL round-trip", () => {
  it("writes nothing for an unfiltered view", () => {
    expect(toPaymentSearchParams(DEFAULT_PAYMENT_FILTERS).toString()).toBe("");
  });

  it("writes nothing for a whitespace-only search, so the view stays clearable", () => {
    // Otherwise `q=  ` regenerates on every param sync (isPaymentFiltered
    // reads it as unfiltered, so nothing ever offers to clear it) and
    // survives reload as a URL nobody asked for.
    expect(toPaymentSearchParams(filters({ search: "  " })).toString()).toBe("");
  });

  it("round-trips a filtered view", () => {
    const f = filters({ search: "acme", state: "unallocated" });
    expect(parsePaymentFilters(toPaymentSearchParams(f))).toEqual(f);
  });

  it("falls back to the default for an unknown state rather than showing nothing", () => {
    const parsed = parsePaymentFilters(new URLSearchParams("state=banana"));
    expect(parsed.state).toBe("all");
  });

  it("returns the defaults for an empty URL", () => {
    expect(parsePaymentFilters(new URLSearchParams(""))).toEqual(DEFAULT_PAYMENT_FILTERS);
  });
});

describe("isPaymentFiltered", () => {
  it("knows when a view is filtered", () => {
    expect(isPaymentFiltered(DEFAULT_PAYMENT_FILTERS)).toBe(false);
    expect(isPaymentFiltered(filters({ search: "  " }))).toBe(false);
    expect(isPaymentFiltered(filters({ search: "x" }))).toBe(true);
    expect(isPaymentFiltered(filters({ state: "partly" }))).toBe(true);
  });
});
