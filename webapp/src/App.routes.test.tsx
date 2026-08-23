/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Same reasoning as money/Payments.test.tsx and PaymentEdit.test.tsx:
// React Query's default scheduler defers notifications to a real
// macrotask, which a plain `await act(async () => render())` never
// observes.
notifyManager.setScheduler((cb) => cb());

const api = {
  listPayments: vi.fn(async () => []),
  listAllocations: vi.fn(async () => []),
  listClients: vi.fn(async () => []),
  listExpenses: vi.fn(async () => []),
  pendingPaymentIds: vi.fn(async () => new Set<string>()),
};

// App.tsx reaches auth/session/sync state through app-context.tsx;
// this replaces it rather than standing up a real Dexie stack and a
// real AuthApiClient for a routing test. useDataReady is the one that
// matters most here: AuthGate renders its Splash instead of the routed
// screen until it is true, which would make every assertion below fail
// for a reason that has nothing to do with routing.
vi.mock("./lib/app-context.tsx", () => ({
  useData: () => api,
  useSyncState: () => ({ online: true, pendingCount: 0 }),
  useServices: () => ({ auth: {}, ready: true }),
  useAuthState: () => ({ user: { email: "test@example.com" }, ready: true, signedIn: true }),
  useSyncEngine: () => null,
  useDataReady: () => true,
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function render(path: string) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <App />
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

describe("App routing — the Money shell", () => {
  // The bug this guards: neither Payments.test.tsx (renders <Payments />
  // directly, never through <App />'s <Routes>) nor HelpProvider.test.tsx
  // (uses "/expenses" as an arbitrary string, not a route match) actually
  // proves the App-level wiring exists. Stripping the <Money> layout
  // route, or deleting the /expenses route outright, left the rest of
  // the suite fully green — this is the test that would have caught it.
  it("renders the Money shell around the payments list at /payments", async () => {
    const el = await render("/payments");
    expect(el.querySelector('[data-testid="money-segment"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="payment-add"]')).not.toBeNull();
  });

  it("renders the Money shell around the expenses list at /expenses", async () => {
    const el = await render("/expenses");
    expect(el.querySelector('[data-testid="money-segment"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="expense-add"]')).not.toBeNull();
  });
});
