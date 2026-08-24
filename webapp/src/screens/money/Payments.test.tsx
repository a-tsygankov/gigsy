/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Payments } from "./Payments.tsx";
import type { Allocation, Client, Payment } from "../../lib/types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// React Query batches store notifications through a real `setTimeout(0)`
// by default, so the component's re-render lands a macrotask after the
// queryFn resolves — a plain `await act(async () => { render() })` only
// drains microtasks and never sees it. `setScheduler` is React Query's
// own documented hook for this exact situation (notifyManager.ts:
// "wrap notifications with React.act while running tests"): running
// the callback immediately keeps every update inside `act`, so
// assertions can read the DOM right after `render()` resolves.
notifyManager.setScheduler((cb) => cb());

const PAYMENTS: Payment[] = [
  {
    id: "p-full",
    gigId: null,
    clientId: "c1",
    amountCents: 15000,
    paidAt: Date.UTC(2026, 8, 10),
    confirmationR2Key: null,
    notes: null,
    createdAt: 0,
    modifiedAt: 0,
  },
  {
    id: "p-open",
    gigId: null,
    clientId: null,
    amountCents: 2500,
    paidAt: Date.UTC(2026, 8, 11),
    confirmationR2Key: null,
    notes: "cash at the door",
    createdAt: 0,
    modifiedAt: 0,
  },
];

const ALLOCATIONS: Allocation[] = [
  { id: "a1", paymentId: "p-full", gigId: "g1", amountCents: 15000, createdAt: 0, modifiedAt: 0 },
];

const CLIENTS: Client[] = [
  { id: "c1", name: "Acme Staffing", contactInfo: null, notes: null, createdAt: 0, modifiedAt: 0 },
];

const api = {
  listPayments: vi.fn(async () => PAYMENTS),
  listAllocations: vi.fn(async () => ALLOCATIONS),
  listClients: vi.fn(async () => CLIENTS),
  pendingPaymentIds: vi.fn(async () => new Set<string>(["p-open"])),
};

// The screen reaches the data service through useData(); this replaces
// it rather than standing up a real Dexie stack for a rendering test.
vi.mock("../../lib/app-context.tsx", () => ({
  useData: () => api,
  useSyncState: () => ({ online: true, pendingCount: 0 }),
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function render(path = "/payments") {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <Payments />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.clearAllMocks();
});

describe("Payments", () => {
  it("lists every payment when unfiltered, newest first", async () => {
    const el = await render();
    const rows = el.querySelectorAll('[data-testid="payment-row"]');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("25.00");
  });

  it("shows the client's name against the payment it belongs to", async () => {
    const el = await render();
    const rows = el.querySelectorAll('[data-testid="payment-row"]');
    // rows[1] is p-full, whose clientId ("c1") resolves to CLIENTS[0].
    expect(rows[1]?.textContent).toContain("Acme Staffing");
  });

  it("labels each row with its own allocation state, not a shared one", async () => {
    const el = await render();
    const rows = el.querySelectorAll('[data-testid="payment-row"]');
    // rows[0] is p-open: no allocation at all. rows[1] is p-full: its
    // one allocation (ALLOCATIONS[0]) covers the whole amount.
    expect(rows[0]?.textContent).toContain("Not yet allocated");
    expect(rows[1]?.textContent).toContain("Allocated");
  });

  it("links each row to its payment", async () => {
    const el = await render();
    const link = el.querySelector('a[href="/payments/p-full"]');
    expect(link).not.toBeNull();
  });

  it("shows only unallocated payments when the URL asks for them", async () => {
    const el = await render("/payments?state=unallocated");
    const rows = el.querySelectorAll('[data-testid="payment-row"]');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain("25.00");
  });

  it("says the filter matched nothing, not that there are no payments", async () => {
    const el = await render("/payments?q=nothingmatchesthis");
    expect(el.textContent).toContain("No payment matches");
    expect(el.textContent).not.toContain("No payments yet");
  });

  it("offers to create a payment with no gig attached", async () => {
    const el = await render();
    const fab = el.querySelector('[data-testid="payment-add"]');
    expect(fab?.getAttribute("href")).toBe("/payments/new");
  });

  it("marks a payment whose changes have not reached the server yet", async () => {
    const el = await render();
    const rows = el.querySelectorAll('[data-testid="payment-row"]');
    // p-open is the pending one, and it sorts first (paidAt is later).
    expect(rows[0]?.querySelector('[data-testid="payment-pending"]')).not.toBeNull();
    expect(rows[1]?.querySelector('[data-testid="payment-pending"]')).toBeNull();
  });

  // Two additions beyond the spec'd suite: p-open (clientId: null) and a
  // null paidAt were already in the fixtures / dateLine's branch table
  // but nothing asserted on either, so a broken fallback (e.g. blank
  // string, or a thrown error on formatting) could have shipped silently.
  it("falls back to \"No client yet\" for a payment with no client", async () => {
    const el = await render();
    const rows = el.querySelectorAll('[data-testid="payment-row"]');
    // rows[0] is p-open, whose clientId is null.
    expect(rows[0]?.textContent).toContain("No client yet");
  });

  it("shows \"No date yet\" for a payment with no paid date", async () => {
    api.listPayments.mockResolvedValueOnce([{ ...PAYMENTS[1]!, paidAt: null }]);
    const el = await render();
    expect(el.textContent).toContain("No date yet");
  });

  it("shows a dedicated empty state when there are no payments at all", async () => {
    api.listPayments.mockResolvedValueOnce([]);
    const el = await render();
    expect(el.textContent).toContain("No payments yet");
    expect(el.textContent).toContain(
      "Record money as it arrives — you can say which work it paid for now or later.",
    );
    expect(el.querySelector('a[href="/payments/new"]')).not.toBeNull();
  });

  // The URL-driven tests above exercise parsePaymentFilters/applyPaymentFilters
  // (already unit-tested in payment-filters.test.ts) but never touch the
  // PaymentFilters control itself — deleting it from the screen, or wiring
  // its search box to write the wrong field, would leave every other test
  // green. This drives the actual input and the actual Clear button.
  it("filters by typing in the search box, and Clear restores every row", async () => {
    const el = await render();
    expect(el.querySelectorAll('[data-testid="payment-row"]')).toHaveLength(2);

    const input = el.querySelector('[data-testid="payment-search"]') as HTMLInputElement;
    // React tracks the input's value through its own internal state, so
    // setting `.value` directly and dispatching a bare event is a no-op —
    // this goes through the native setter React's change detection
    // actually observes (the same trick @testing-library/react's
    // fireEvent uses under the hood).
    const nativeSetValue = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    await act(async () => {
      nativeSetValue.call(input, "acme");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(el.querySelectorAll('[data-testid="payment-row"]')).toHaveLength(1);
    const clear = el.querySelector('[data-testid="payment-clear"]');
    expect(clear).not.toBeNull();

    await act(async () => {
      (clear as HTMLElement).click();
    });

    expect(el.querySelectorAll('[data-testid="payment-row"]')).toHaveLength(2);
  });
});
