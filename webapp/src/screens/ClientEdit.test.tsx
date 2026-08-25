/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientEdit } from "./ClientEdit.tsx";
import { HelpProvider } from "../help/runtime/HelpProvider.tsx";
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
// same module (useServices/useAuthState/useSyncEngine) — none of which
// the plan's original mock supplied. Without stubbing them AppHeader
// throws before ClientEdit's own history grouping ever gets a chance to
// render.
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
          {/* ClientEdit renders AppHeader, and AppHeader reads help
              state via useHelp() — real, not mocked, since it is
              unrelated to what this test is checking (same pattern as
              PaymentEdit.test.tsx). */}
          <HelpProvider>
            <Routes>
              <Route path="/clients/:id" element={<ClientEdit />} />
            </Routes>
          </HelpProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return container;
}

/** The rendered text of the group whose heading is `title`. */
function groupText(el: HTMLElement, title: string): string {
  const headings = [...el.querySelectorAll("h3")].filter(
    (n) => n.textContent?.trim() === title,
  );
  if (headings.length > 1) throw new Error(`ambiguous group heading: ${title}`);
  // An absent group is "", but a heading this helper can no longer
  // recognise (renamed, or given a count suffix) must fail loudly —
  // otherwise every `.not.toContain` below silently becomes a
  // tautology.
  if (headings.length === 0) {
    if (el.textContent?.includes(title) === true)
      throw new Error(`group heading "${title}" is on the page but not matched exactly`);
    return "";
  }
  return headings[0]!.parentElement?.textContent ?? "";
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

  it("does not sweep non-done gigs into the history groups", async () => {
    // Nothing above exercises a status that must stay OUT of the
    // completed groups — every prior fixture is "delivered". A
    // predicate that admits everything (e.g. `isDone` degenerating to
    // `true`) would pass all three tests above while also putting
    // leads, confirmed and cancelled gigs into the client's paid/unpaid
    // history — and a lead would then show up in "Upcoming & leads"
    // AND a completed group at once.
    const el = await render([
      gig({ id: "lead1", status: "lead", location: "Pitch site" }),
      gig({ id: "cx", status: "cancelled", location: "Fell through site" }),
    ]);
    for (const group of ["Completed — not paid", "Paid"]) {
      expect(groupText(el, group)).not.toContain("Pitch site");
      expect(groupText(el, group)).not.toContain("Fell through site");
    }
  });
});
