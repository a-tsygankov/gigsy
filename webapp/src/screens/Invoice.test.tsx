/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Invoice, invoiceParams, unpricedNotice } from "./Invoice.tsx";
import { HelpProvider } from "../help/runtime/HelpProvider.tsx";
import type { Client, Expense, Gig, Service } from "../lib/types.ts";
import type { Settings } from "../lib/settings-schema.ts";

describe("invoiceParams", () => {
  it("reads the client, the number, the issue date and the bounds", () => {
    expect(
      invoiceParams(new URLSearchParams("client=c1&n=7&issued=1000&from=100&to=200")),
    ).toEqual({
      clientId: "c1",
      number: 7,
      issuedAt: 1000,
      filters: { from: 100, to: 200 },
    });
  });

  it("leaves bounds out when they are absent", () => {
    expect(invoiceParams(new URLSearchParams("client=c1&n=7&issued=1000"))).toEqual({
      clientId: "c1",
      number: 7,
      issuedAt: 1000,
      filters: {},
    });
  });

  it("names the gigs it could not price, so nobody under-bills in silence", () => {
    // Not a nicety: `buildInvoice` drops work whose price is unknown
    // rather than billing zero, and this banner is the only place that
    // fact surfaces before the document is sent.
    expect(
      unpricedNotice({ unpricedGigs: [{ id: "g1", description: "Tasting" }] }),
    ).toBe("1 completed gig has no price set, so it is not on this invoice:");
    expect(
      unpricedNotice({
        unpricedGigs: [
          { id: "g1", description: "Tasting" },
          { id: "g2", description: "Promo" },
        ],
      }),
    ).toBe("2 completed gigs have no price set, so they are not on this invoice:");
  });

  it("refuses a missing client rather than inventing one", () => {
    expect(invoiceParams(new URLSearchParams("n=7&issued=1000"))).toBeNull();
  });

  it("refuses a number that is not a positive integer", () => {
    // A hand-edited URL must not print "INV-NaN" on a document that
    // gets sent to somebody.
    expect(invoiceParams(new URLSearchParams("client=c1&n=x&issued=1000"))).toBeNull();
    expect(invoiceParams(new URLSearchParams("client=c1&n=0&issued=1000"))).toBeNull();
    expect(invoiceParams(new URLSearchParams("client=c1&issued=1000"))).toBeNull();
  });

  it("refuses an issue date that is not a positive integer", () => {
    // Same reasoning as the number check: a document printing "Invalid
    // Date" is worse than a link that admits it is broken. The issue
    // date fixes the document to the link (Task 4 stamps it once, at
    // allocation), so a missing or nonsense one is refused the same way.
    expect(invoiceParams(new URLSearchParams("client=c1&n=1"))).toBeNull();
    expect(invoiceParams(new URLSearchParams("client=c1&n=1&issued=x"))).toBeNull();
    expect(invoiceParams(new URLSearchParams("client=c1&n=1&issued=0"))).toBeNull();
    expect(invoiceParams(new URLSearchParams("client=c1&n=1&issued=-5"))).toBeNull();
  });

  it("ignores a bound that is not a number", () => {
    expect(invoiceParams(new URLSearchParams("client=c1&n=1&issued=1000&from=x"))).toEqual({
      clientId: "c1",
      number: 1,
      issuedAt: 1000,
      filters: {},
    });
  });

  it("ignores a bound that is present but empty, rather than treating it as epoch 0", () => {
    // `Number("") === 0`, so without checking the raw string first, a
    // hand-edited `?from=` or `?to=` becomes a real bound at epoch 0 —
    // for `to`, one that outdates every real gig and silently empties
    // the invoice. That is a link inventing an answer instead of
    // refusing, the same failure mode `n` and `issued` are refused for.
    expect(
      invoiceParams(new URLSearchParams("client=c1&n=1&issued=1000&from=")),
    ).toEqual({ clientId: "c1", number: 1, issuedAt: 1000, filters: {} });
    expect(
      invoiceParams(new URLSearchParams("client=c1&n=1&issued=1000&to=")),
    ).toEqual({ clientId: "c1", number: 1, issuedAt: 1000, filters: {} });
  });
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Same reasoning as Gigs.test.tsx: TanStack v5 defers the
// store-subscription callback to a real macrotask, which `await act`
// never drains.
notifyManager.setScheduler((cb) => cb());

const CLIENT: Client = {
  id: "c1", name: "Bar Co", contactInfo: null, notes: null, createdAt: 0, modifiedAt: 0,
};

function gig(over: Partial<Gig>): Gig {
  return {
    id: "g1",
    clientId: "c1",
    parentGigId: null,
    title: "Tasting",
    status: "completed",
    location: null,
    dateTime: Date.UTC(2026, 0, 1),
    durationMinutes: null,
    payType: "fixed",
    hourlyRateCents: null,
    workStartedAt: null,
    workEndedAt: null,
    breakMinutes: null,
    calendarEventId: null,
    amountOfferedCents: null,
    amountPaidCents: null,
    expectedCents: null,
    notes: null,
    source: null,
    createdAt: 0,
    modifiedAt: 0,
    ...over,
  };
}

const SETTINGS = {
  businessName: "Me",
  businessAddress: null,
  businessContact: null,
  businessTaxId: null,
  businessPaymentDetails: null,
  invoiceNextNumber: 1,
  invoicePaymentTermsDays: 14,
} as unknown as Settings;

const api = {
  listGigs: vi.fn(async () => [] as Gig[]),
  listServices: vi.fn(async () => [] as Service[]),
  listExpenses: vi.fn(async () => [] as Expense[]),
  listClients: vi.fn(async () => [CLIENT]),
  getSettings: vi.fn(async () => SETTINGS),
  updateSettings: vi.fn(async () => SETTINGS),
};

// Invoice renders <AppHeader>, whose dependencies all come through this
// module — the same set Gigs.test.tsx stubs, and for the same reason:
// without them the header throws before the document under test
// renders at all.
vi.mock("../lib/app-context.tsx", () => ({
  useData: () => api,
  useSyncState: () => ({ online: true, pendingCount: 0 }),
  useServices: () => ({ auth: {}, authApi: {}, api: {}, ready: true }),
  useAuthState: () => ({
    ready: true,
    signedIn: true,
    user: { id: "u1", email: "test@example.com" },
  }),
  useSyncEngine: () => null,
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/reports/invoice?client=c1&n=1&issued=1000"]}>
          <HelpProvider>
            <Routes>
              <Route path="/reports/invoice" element={<Invoice />} />
            </Routes>
          </HelpProvider>
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

const byId = (el: HTMLElement, id: string) => el.querySelector(`[data-testid="${id}"]`);

describe("Invoice — which render is which", () => {
  it("shows the unpriced banner alongside the empty-document card when the only qualifying work has no price", async () => {
    // A completed, in-range gig for this client whose fixed amount was
    // never set — `buildInvoice` cannot price it, so it lands in
    // `unpricedGigs` rather than being billed at $0, and there is
    // nothing else to invoice: both banners are the true answer at once.
    api.listGigs.mockResolvedValueOnce([gig({})]);
    const el = await render();
    expect(byId(el, "invoice-unpriced")).not.toBeNull();
    expect(byId(el, "invoice-empty-doc")).not.toBeNull();
  });

  it("shows the load-error card, not the empty-document card, when a ledger read fails", async () => {
    // Pins the fix for the bug the pending gate let through: an errored
    // `gigs` read must never render as "Nothing to invoice" — that is a
    // complete, printable document captioned as if it were the honest
    // answer, on a route whose whole point is to be printed and sent.
    api.listGigs.mockRejectedValueOnce(new Error("offline"));
    const el = await render();
    expect(byId(el, "invoice-load-error")).not.toBeNull();
    expect(byId(el, "invoice-empty-doc")).toBeNull();
    expect(byId(el, "invoice-print")).toBeNull();
  });

  it("renders a line and the total for a priced gig", async () => {
    api.listGigs.mockResolvedValueOnce([gig({ amountOfferedCents: 5000, expectedCents: 5000 })]);
    const el = await render();
    expect(byId(el, "invoice-lines")).not.toBeNull();
    const total = byId(el, "invoice-total");
    expect(total).not.toBeNull();
    expect(total!.textContent).toContain("$50.00");
  });
});
