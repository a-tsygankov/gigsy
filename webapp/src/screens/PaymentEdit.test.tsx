/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";
import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PaymentEdit } from "./PaymentEdit.tsx";
import { HelpProvider } from "../help/runtime/HelpProvider.tsx";
import type { Allocation, Client, Gig, Payment } from "../lib/types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Same reasoning as money/Payments.test.tsx: React Query's default
// scheduler defers notifications to a real macrotask, which a plain
// `await act(async () => render())` never observes.
notifyManager.setScheduler((cb) => cb());

const PAYMENT: Payment = {
  id: "p1",
  gigId: null,
  clientId: null,
  amountCents: 10000,
  paidAt: Date.UTC(2026, 7, 1),
  confirmationR2Key: null,
  notes: null,
  createdAt: 0,
  modifiedAt: 0,
};

const GIGS: Gig[] = [];
const CLIENTS: Client[] = [];

function makeApi(allocations: Allocation[]) {
  return {
    getPayment: vi.fn(async () => PAYMENT),
    listAllocationsByPayment: vi.fn(async () => allocations),
    listGigs: vi.fn(async () => GIGS),
    listClients: vi.fn(async () => CLIENTS),
    queuedPaymentConfirmation: vi.fn(async () => null),
    getPaymentConfirmationBlob: vi.fn(async () => null),
    putPayment: vi.fn(),
    deleteAllocation: vi.fn(),
    putAllocation: vi.fn(),
    queuePaymentConfirmation: vi.fn(),
    deletePayment: vi.fn(async () => undefined),
  };
}

let api: ReturnType<typeof makeApi>;

vi.mock("../lib/app-context.tsx", () => ({
  useData: () => api,
  useSyncState: () => ({ online: true, pendingCount: 0 }),
  // Pulled in only because this screen renders AppHeader, which reads
  // these directly — PaymentEdit itself never touches them.
  useServices: () => ({ auth: {}, ready: true }),
  useAuthState: () => ({ user: { email: "test@example.com" }, ready: true, signedIn: true }),
  useSyncEngine: () => null,
}));

/** Marks which route the navigation actually landed on, including the
 *  `:id` a `/gigs/:id` landing carries. */
function LandedGig() {
  const { id } = useParams();
  return <div data-testid="landed-gig">{id}</div>;
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function render(allocations: Allocation[]) {
  api = makeApi(allocations);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/payments/p1"]}>
          {/* PaymentEdit renders AppHeader, and AppHeader reads help
              state via useHelp() — real, not mocked, since it is
              unrelated to what this test is checking. */}
          <HelpProvider>
            <Routes>
              <Route path="/payments/:id" element={<PaymentEdit />} />
              <Route path="/payments" element={<div data-testid="landed-payments" />} />
              <Route path="/gigs/:id" element={<LandedGig />} />
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

describe("PaymentEdit back target", () => {
  // The bug this guards: a payment with no single gig (unallocated, or
  // split across several) used to fall back to `/gigs` — the only
  // sensible fallback before the Money tab existed. Now that `/payments`
  // is a real route, Cancel/Save/Delete on exactly the gig-less payment
  // this feature exists to support should return there, not to the gig
  // list it never came from.
  it("sends Cancel to /payments when the payment has no single gig", async () => {
    const el = await render([]);
    const cancel = el.querySelector('[data-testid="payment-cancel"]') as HTMLButtonElement;
    expect(cancel).not.toBeNull();

    await act(async () => {
      cancel.click();
    });

    expect(el.querySelector('[data-testid="landed-payments"]')).not.toBeNull();
  });

  it("still sends Cancel to the sole gig when the payment has exactly one", async () => {
    const el = await render([
      { id: "a1", paymentId: "p1", gigId: "g1", amountCents: 10000, createdAt: 0, modifiedAt: 0 },
    ]);
    const cancel = el.querySelector('[data-testid="payment-cancel"]') as HTMLButtonElement;
    expect(cancel).not.toBeNull();

    await act(async () => {
      cancel.click();
    });

    const landed = el.querySelector('[data-testid="landed-gig"]');
    expect(landed).not.toBeNull();
    expect(landed!.textContent).toBe("g1");
  });
});
