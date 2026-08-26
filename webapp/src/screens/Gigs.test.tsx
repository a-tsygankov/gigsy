/** @vitest-environment jsdom */

/**
 * What the gig screen SAYS in each of its four renders — and, in
 * particular, that it only says "No gigs yet" in one of them.
 *
 * The distinction is load-bearing outside this screen. Two help
 * scenarios branch on `gigs-empty` to decide whether to tell somebody
 * their account owns nothing (help/targets.ts's `GigsEmpty`), and they
 * do that instead of reading the ABSENCE of `gig-filters` because the
 * filter bar hangs off `all.length > 0`, where `all` is `gigs.data ??
 * []` — empty while the query is pending and again after it has
 * errored. So "no filter bar" was three renders wearing one face, and
 * the test that matters here is the pair of negatives: pending shows no
 * empty state, errored shows no empty state.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Gigs } from "./Gigs.tsx";
import { HelpProvider } from "../help/runtime/HelpProvider.tsx";
import type { Client, Gig } from "../lib/types.ts";
import type { Settings } from "../lib/settings-schema.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Same reasoning as Dashboard.test.tsx: TanStack v5 defers the
// store-subscription callback to a real macrotask, which `await act`
// never drains.
notifyManager.setScheduler((cb) => cb());

const GIG: Gig = {
  id: "g1",
  clientId: null,
  parentGigId: null,
  title: "Tasting, Soho",
  status: "confirmed",
  location: null,
  dateTime: Date.UTC(2026, 7, 1),
  durationMinutes: 180,
  payType: "fixed",
  hourlyRateCents: null,
  workStartedAt: null,
  workEndedAt: null,
  breakMinutes: null,
  calendarEventId: null,
  amountOfferedCents: 15000,
  amountPaidCents: null,
  expectedCents: 15000,
  notes: null,
  source: "manual",
  createdAt: 0,
  modifiedAt: 0,
};

// Only the gig-list half is real; the rest of Settings is never read by
// this screen. `filtersFromSettings` takes the six `gigList*` fields and
// nothing else, and the seeding effect skips a saved view that
// serialises to nothing — which is what these defaults do, so the URL
// stays empty and the list stays unfiltered.
const SETTINGS = {
  gigListStatuses: [],
  gigListSort: "newest",
  gigListHidePast: false,
  gigListClientId: null,
  gigListFrom: null,
  gigListTo: null,
} as unknown as Settings;

const api = {
  listGigs: vi.fn(async () => [GIG]),
  listClients: vi.fn(async () => [] as Client[]),
  pendingGigIds: vi.fn(async () => new Set<string>()),
  getSettings: vi.fn(async () => SETTINGS),
  updateSettings: vi.fn(async () => SETTINGS),
};

// Gigs renders <AppHeader>, whose dependencies all come through this
// module — the same set Dashboard.test.tsx stubs, and for the same
// reason: without them the header throws before the list under test
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
        <MemoryRouter initialEntries={["/gigs"]}>
          <HelpProvider>
            <Routes>
              <Route path="/gigs" element={<Gigs />} />
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

const empty = (el: HTMLElement) => el.querySelector('[data-testid="gigs-empty"]');
const filters = (el: HTMLElement) => el.querySelector('[data-testid="gig-filters"]');

describe("Gigs — which render is which", () => {
  it("tags the empty state, and shows it only once the query has answered with nothing", async () => {
    api.listGigs.mockResolvedValueOnce([]);
    const el = await render();
    expect(empty(el)).not.toBeNull();
    expect(empty(el)!.textContent).toContain("No gigs yet");
    // The other half of "no gigs": nothing to narrow, so no filter bar.
    expect(filters(el)).toBeNull();
  });

  it("shows no empty state while the query is still pending", async () => {
    // Never resolves — the point is to catch the screen mid-flight.
    api.listGigs.mockReturnValueOnce(new Promise(() => {}));
    const el = await render();
    expect(el.querySelector('[data-testid="skeleton"]')).not.toBeNull();
    // Both absent. This is the render that used to be indistinguishable
    // from "this account owns no gigs".
    expect(empty(el)).toBeNull();
    expect(filters(el)).toBeNull();
  });

  it("shows no empty state when the query has errored", async () => {
    api.listGigs.mockRejectedValueOnce(new Error("offline"));
    const el = await render();
    expect(el.textContent).toContain("Couldn't load gigs");
    // The screen makes no claim about the account here, and neither
    // should anything reading it.
    expect(empty(el)).toBeNull();
    expect(filters(el)).toBeNull();
  });

  it("shows the filter bar and no empty state once gigs are listed", async () => {
    const el = await render();
    expect(filters(el)).not.toBeNull();
    expect(el.querySelector('[data-testid="gig-list"]')).not.toBeNull();
    expect(empty(el)).toBeNull();
  });
});
