/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "./Dashboard.tsx";
import { HelpProvider } from "../help/runtime/HelpProvider.tsx";
import type { DashboardSummary, Draft } from "../lib/types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// TanStack Query v5 schedules the store-subscription callback that
// triggers React's re-render through a real setTimeout(fn, 0).
// `await act` only drains microtasks, so without this the assertions
// race the timer and the file is non-deterministic. TanStack's own
// documented escape hatch for tests.
notifyManager.setScheduler((cb) => cb());

// Every count on the summary gets its own distinct value: if the tile
// under test read the wrong field it would show a visibly wrong
// number (e.g. 3 instead of 41) rather than a coincidentally correct
// one.
const SUMMARY: DashboardSummary = {
  completedCount: 3,
  awaitingDeliveryCount: 41,
  expectedCents: 500000,
  unpaidCents: 250000,
  unpaidJobs: [],
};

const api = {
  getDashboard: vi.fn(async () => SUMMARY),
  listDrafts: vi.fn(async () => [] as Draft[]),
  getCalendarStatus: vi.fn(async () => ({ connected: false, lastSyncAt: null })),
};

// Dashboard renders <AppHeader>, and its own CalendarSection, whose
// combined dependencies go through this same module — the same set
// ClientEdit.test.tsx needed for the same reason: without stubbing
// all of them, AppHeader or CalendarSection throw before the tiles
// under test ever get a chance to render.
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
        <MemoryRouter initialEntries={["/"]}>
          {/* Real HelpProvider, not mocked — unrelated to what this
              test checks (same pattern as ClientEdit.test.tsx /
              PaymentEdit.test.tsx). */}
          <HelpProvider>
            <Routes>
              <Route path="/" element={<Dashboard />} />
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

describe("Dashboard — awaiting delivery tile", () => {
  it("reads awaitingDeliveryCount, not completedCount or any other field", async () => {
    const el = await render();
    const tile = el.querySelector('[data-testid="tile-awaiting-delivery"]');
    expect(tile?.textContent).toBe("41");
    // Pinned against its neighbour: if the tile read completedCount
    // instead, this would show "3" — the same number as the tile
    // right next to it — so the two assertions can't be satisfied by
    // the same bug.
    const completedTile = el.querySelector('[data-testid="tile-completed"]');
    expect(completedTile?.textContent).toBe("3");
    expect(tile?.textContent).not.toBe(completedTile?.textContent);
  });

  it("links the tile to the completed gig list", async () => {
    const el = await render();
    const link = el.querySelector('[data-testid="tile-awaiting-delivery"]')?.closest("a");
    expect(link?.getAttribute("href")).toBe("/gigs?status=completed");
  });
});
