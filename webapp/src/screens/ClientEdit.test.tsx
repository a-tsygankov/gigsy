/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientEdit } from "./ClientEdit.tsx";
import type { Client, Gig } from "../lib/types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// TanStack Query v5 schedules the store-subscription callback that
// triggers React's re-render through a real setTimeout(fn, 0).
// `await act` only drains microtasks, so without this the assertions
// race the timer and the file is non-deterministic. TanStack's own
// documented escape hatch for tests.
notifyManager.setScheduler((cb) => cb());

const CLIENT: Client = {
  id: "c1",
  name: "Acme Staffing",
  contactInfo: null,
  notes: null,
  createdAt: 0,
  modifiedAt: 0,
};

// Identify a fixture gig by `location`, not `title`: JobRow (ClientEdit.tsx)
// renders the former in every row and never renders the latter at all, so
// a test that set a distinctive `title` to find its gig in the DOM would
// fail even against a correct fix — for the wrong reason.
function gig(over: Partial<Gig>): Gig {
  return {
    id: "g1",
    clientId: "c1",
    title: null,
    status: "completed",
    location: null,
    dateTime: 0,
    durationMinutes: null,
    payType: "fixed",
    hourlyRateCents: null,
    workStartedAt: null,
    workEndedAt: null,
    breakMinutes: null,
    calendarEventId: null,
    amountOfferedCents: 20000,
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
  getClient: vi.fn(async () => CLIENT),
  listGigs: vi.fn(async () => [] as Gig[]),
};

// ClientEdit renders <AppHeader>, whose own dependencies go through this
// same module (useServices/useAuthState/useSyncEngine) and through
// useHelp (../help/runtime/HelpProvider.tsx) — none of which the plan's
// original mock supplied. Without stubbing them AppHeader throws
// ("useHelp outside HelpProvider") before ClientEdit's own history
// grouping ever gets a chance to render.
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

vi.mock("../help/runtime/HelpProvider.tsx", () => ({
  useHelp: () => ({
    isOpen: false,
    openHelp: () => {},
    closeHelp: () => {},
    startScenario: async () => {},
    unavailable: null,
    dismissUnavailable: () => {},
  }),
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function render(gigs: Gig[]) {
  api.listGigs.mockResolvedValue(gigs);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/clients/c1"]}>
          <Routes>
            <Route path="/clients/:id" element={<ClientEdit />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return container;
}

/** The rendered text of the group whose heading is `title`. */
function groupText(el: HTMLElement, title: string): string {
  const heading = [...el.querySelectorAll("*")].find(
    (n) => n.textContent?.trim() === title,
  );
  return heading?.parentElement?.textContent ?? "";
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.clearAllMocks();
});

describe("ClientEdit history", () => {
  it("keeps an unpaid delivered gig in the not-paid group", async () => {
    const el = await render([
      gig({
        id: "sent",
        status: "delivered",
        location: "Handed over site",
        amountPaidCents: 0,
      }),
    ]);
    expect(groupText(el, "Completed — not paid")).toContain("Handed over site");
  });

  it("keeps a paid delivered gig in the paid group", async () => {
    const el = await render([
      gig({
        id: "sent-paid",
        status: "delivered",
        location: "Handed over and settled site",
        amountPaidCents: 20000,
      }),
    ]);
    expect(groupText(el, "Paid")).toContain("Handed over and settled site");
  });

  it("does not lose a delivered gig from the history entirely", async () => {
    // The failure mode this file exists for. Before the fix a delivered
    // gig matched NEITHER group and vanished — harder to notice than a
    // wrong number, because nothing looks visibly off.
    const el = await render([
      gig({ id: "sent", status: "delivered", location: "Handed over site" }),
    ]);
    expect(el.textContent).toContain("Handed over site");
    // "Rendered somewhere" alone would also pass if a delivered gig were
    // swept into the wrong bucket — "Upcoming & leads" is the one other
    // group in this screen and filters on ["lead", "confirmed"], so a
    // sloppy widening of THAT filter instead of the completed groups
    // would still satisfy the assertion above. Pin it out of that group
    // specifically so this test can't be satisfied by a misroute.
    expect(groupText(el, "Upcoming & leads")).not.toContain("Handed over site");
  });
});
