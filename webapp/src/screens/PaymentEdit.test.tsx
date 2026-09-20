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

const TASTING: Gig = {
  id: "g1",
  clientId: null,
  parentGigId: null,
  batchId: null,
  title: "Arrange a tasting",
  status: "confirmed",
  location: "Soho",
  dateTime: null,
  durationMinutes: null,
  payType: "fixed",
  hourlyRateCents: null,
  workStartedAt: null,
  workEndedAt: null,
  breakMinutes: null,
  calendarEventId: null,
  amountOfferedCents: 10000,
  amountPaidCents: null,
  expectedCents: 10000,
  notes: null,
  source: null,
  createdAt: 0,
  modifiedAt: 0,
};

function makeApi(allocations: Allocation[], gigs: Gig[] = GIGS) {
  return {
    getPayment: vi.fn(async () => PAYMENT),
    listAllocationsByPayment: vi.fn(async () => allocations),
    listGigs: vi.fn(async () => gigs),
    listClients: vi.fn(async () => CLIENTS),
    // The split rows' gig pickers ask `useSettings` for
    // `clientsExpectDelivery` (lib/gig-delivery.ts); nothing else on
    // this screen reads settings.
    getSettings: vi.fn(async () => ({ clientsExpectDelivery: false })),
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

async function render(allocations: Allocation[], gigs: Gig[] = GIGS) {
  api = makeApi(allocations, gigs);
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

describe("PaymentEdit split rows", () => {
  // Each row's gig is a GigPicker (components/GigPicker.tsx): a trigger
  // in the row, a sheet portalled to <body>. The trigger keeps the
  // indexed id the `<select>` had, so the payment help scenario still
  // resolves `payment-gig-0`.
  const inSheet = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

  it("picks a gig for the first row through the sheet", async () => {
    const el = await render([], [TASTING]);
    const trigger = el.querySelector<HTMLButtonElement>('[data-testid="payment-gig-0"]')!;
    expect(trigger.getAttribute("aria-label")).toContain("Gig 1");
    expect(trigger.dataset["value"]).toBe("");

    await act(async () => {
      trigger.click();
    });
    // No "none" row: a split row without a gig is removed with the ✕
    // beside it, never blanked from inside the picker.
    expect(inSheet("payment-gig-0-none")).toBeNull();
    await act(async () => {
      inSheet("payment-gig-0-row-g1")!.click();
    });

    expect(inSheet("payment-gig-0-sheet")).toBeNull();
    expect(trigger.dataset["value"]).toBe("g1");
    expect(trigger.textContent).toContain("Arrange a tasting");
  });
});

describe("PaymentEdit spreads the amount across the chosen gigs", () => {
  const SHIFT: Gig = { ...TASTING, id: "g2", title: "Evening shift", expectedCents: 5000, amountOfferedCents: 5000 };
  const byId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const amountBox = (i: number) => byId(`payment-split-amount-${i}`) as HTMLInputElement;

  /** Type into a controlled input the way React hears it. */
  async function type(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function pickGig(rowIndex: number, gigId: string) {
    await act(async () => {
      byId(`payment-gig-${rowIndex}`)!.click();
    });
    await act(async () => {
      byId(`payment-gig-${rowIndex}-row-${gigId}`)!.click();
    });
  }

  it("gives the whole amount to a lone gig, once one is chosen", async () => {
    // The screenshot that prompted this: 60 typed, one gig picked, and
    // the row still read 0.00 with "Unallocated $60.00" beneath it —
    // choosing the gig used to count as touching the split.
    await render([], [TASTING, SHIFT]);
    await type(byId("payment-amount") as HTMLInputElement, "60");
    await pickGig(0, "g1");
    expect(amountBox(0).value).toBe("60.00");
    expect(byId("payment-unallocated")?.textContent).toBe("Fully allocated");
  });

  it("fills the first gig up to what it is owed and hands the rest to the next", async () => {
    await render([], [TASTING, SHIFT]);
    await type(byId("payment-amount") as HTMLInputElement, "120");
    await pickGig(0, "g1");
    await act(async () => {
      byId("payment-add-split")!.click();
    });
    await pickGig(1, "g2");
    // TASTING is owed 100.00; SHIFT, last, takes the remaining 20.00.
    expect(amountBox(0).value).toBe("100.00");
    expect(amountBox(1).value).toBe("20.00");
    expect(byId("payment-unallocated")?.textContent).toBe("Fully allocated");
  });

  it("keeps spreading as the amount changes, until an amount box is typed into", async () => {
    await render([], [TASTING, SHIFT]);
    await type(byId("payment-amount") as HTMLInputElement, "60");
    await pickGig(0, "g1");
    await type(byId("payment-amount") as HTMLInputElement, "75");
    expect(amountBox(0).value).toBe("75.00");

    // From here the figure is the user's: a later change to the total
    // must not overwrite it.
    await type(amountBox(0), "40");
    await type(byId("payment-amount") as HTMLInputElement, "90");
    expect(amountBox(0).value).toBe("40");
    expect(byId("payment-unallocated")?.textContent).toBe("Unallocated $50.00");
  });
});
