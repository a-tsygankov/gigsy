/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GigDetail } from "./GigDetail.tsx";
import { HelpProvider } from "../help/runtime/HelpProvider.tsx";
import type { Client, Gig } from "../lib/types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// TanStack Query v5 schedules the re-render through a real
// setTimeout(fn, 0). `await act` drains only microtasks, so without
// this the assertions race the timer and the file is non-deterministic.
notifyManager.setScheduler((cb) => cb());

const ACME: Client = {
  id: "c1", name: "Acme", contactInfo: null, notes: null, createdAt: 0, modifiedAt: 0,
};

function gig(over: Partial<Gig>): Gig {
  return {
    id: "g1",
    clientId: "c1",
    parentGigId: null,
    title: null,
    status: "confirmed",
    location: null,
    dateTime: 0,
    durationMinutes: null,
    payType: "fixed",
    hourlyRateCents: null,
    workStartedAt: null,
    workEndedAt: null,
    breakMinutes: null,
    calendarEventId: null,
    amountOfferedCents: null,
    amountPaidCents: 0,
    expectedCents: null,
    notes: null,
    source: null,
    createdAt: 0,
    modifiedAt: 0,
    ...over,
  };
}

const api = {
  getGig: vi.fn(async (id: string) => ALL.find((g) => g.id === id) ?? null),
  listGigs: vi.fn(async () => ALL),
  listClients: vi.fn(async () => [ACME]),
  listServicesByGig: vi.fn(async () => []),
  listPaymentsByGig: vi.fn(async () => []),
  listAllocationsByGig: vi.fn(async () => []),
};

let ALL: Gig[] = [];

vi.mock("../lib/app-context.tsx", () => ({
  useData: () => api,
  useSyncState: () => ({ online: true, pendingCount: 0 }),
  useServices: () => ({ ready: true }),
  useAuthState: () => ({ user: { email: "t@e.com" }, ready: true, signedIn: true }),
  useSyncEngine: () => null,
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function render(all: Gig[], openId: string) {
  ALL = all;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[`/gigs/${openId}`]}>
          <HelpProvider>
            <Routes>
              <Route path="/gigs/:id" element={<GigDetail />} />
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

describe("GigDetail parent link", () => {
  it("says what this gig is part of, and links to it", async () => {
    const parent = gig({ id: "p", title: "The original booking" });
    const child = gig({ id: "k", title: "Second day", parentGigId: "p" });
    const el = await render([parent, child], "k");

    const line = el.querySelector('[data-testid="gig-parent"]');
    expect(line).not.toBeNull();
    expect(line?.textContent).toContain("The original booking");
    expect(line?.querySelector('a[href="/gigs/p"]')).not.toBeNull();
  });

  it("lists what came out of this gig", async () => {
    const parent = gig({ id: "p", title: "The original booking" });
    const a = gig({ id: "k1", title: "Second day", parentGigId: "p" });
    const b = gig({ id: "k2", title: "Third day", parentGigId: "p" });
    const el = await render([parent, a, b], "p");

    const list = el.querySelector('[data-testid="gig-children"]');
    expect(list).not.toBeNull();
    expect(list?.textContent).toContain("Second day");
    expect(list?.textContent).toContain("Third day");
    expect(list?.querySelectorAll("a")).toHaveLength(2);
  });

  it("shows neither surface for a gig that is part of nothing", async () => {
    const lone = gig({ id: "solo", title: "One and done" });
    const el = await render([lone], "solo");

    expect(el.querySelector('[data-testid="gig-parent"]')).toBeNull();
    expect(el.querySelector('[data-testid="gig-children"]')).toBeNull();
  });

  it("does not list an unrelated gig as a child", async () => {
    // The filter is `g.parentGigId === gig.id`, and a bare truthiness
    // check or a `!== null` would sweep in every linked gig in the app.
    const parent = gig({ id: "p", title: "The original booking" });
    const mine = gig({ id: "k1", title: "Second day", parentGigId: "p" });
    const theirs = gig({ id: "x", title: "Someone else's follow-up", parentGigId: "other" });
    const el = await render([parent, mine, theirs], "p");

    const list = el.querySelector('[data-testid="gig-children"]');
    expect(list?.textContent).toContain("Second day");
    expect(list?.textContent).not.toContain("Someone else's follow-up");
  });
});
