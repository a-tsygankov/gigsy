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
  needsDelivery: false,
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
    parentGigId: null,
    batchId: null,
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

/** What the settings query answers. Reassigned per test; the mock
 *  reads it at call time so a test can flip the default before
 *  rendering. */
let settingsValue: { clientsExpectDelivery: boolean } = { clientsExpectDelivery: false };

const api = {
  getClient: vi.fn(async () => CLIENT),
  listGigs: vi.fn(async () => [] as Gig[]),
  getSettings: vi.fn(async () => settingsValue),
  putClient: vi.fn(async () => CLIENT),
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

async function render(gigs: Gig[], route = "/clients/c1") {
  api.listGigs.mockResolvedValue(gigs);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[route]}>
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
  settingsValue = { clientsExpectDelivery: false };
  vi.clearAllMocks();
});

const deliveryToggle = (el: HTMLElement) =>
  el.querySelector<HTMLInputElement>('[data-testid="client-needs-delivery"]');

describe("ClientEdit delivery switch", () => {
  it("starts off on a new client when the setting is off", async () => {
    const el = await render([], "/clients/new");
    expect(deliveryToggle(el)?.checked).toBe(false);
  });

  it("starts on on a new client when the setting is on", async () => {
    // The setting resolves AFTER mount; the form has to pick it up
    // once it lands rather than reading it on the first render only.
    settingsValue = { clientsExpectDelivery: true };
    const el = await render([], "/clients/new");
    expect(deliveryToggle(el)?.checked).toBe(true);
  });

  it("saves the switch through putClient", async () => {
    const el = await render([], "/clients/new");
    const name = el.querySelector<HTMLInputElement>('[data-testid="client-name"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      name,
      "Shoots Ltd",
    );
    await act(async () => {
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      deliveryToggle(el)!.click();
    });
    await act(async () => {
      el.querySelector<HTMLButtonElement>('[data-testid="client-save"]')!.click();
    });

    expect(api.putClient).toHaveBeenCalledTimes(1);
    const [, input] = api.putClient.mock.calls[0] as unknown as [string, { needsDelivery: boolean }];
    expect(input.needsDelivery).toBe(true);
  });

  it("shows the stored value on an existing client, whatever the setting says", async () => {
    // An existing client never reads the setting: the record is the
    // truth. The setting is on here precisely so a screen that seeded
    // from it by mistake would show the wrong state.
    settingsValue = { clientsExpectDelivery: true };
    api.getClient.mockResolvedValue({ ...CLIENT, needsDelivery: false });
    const el = await render([]);
    expect(deliveryToggle(el)?.checked).toBe(false);
  });

  it("shows a stored true on an existing client", async () => {
    api.getClient.mockResolvedValue({ ...CLIENT, needsDelivery: true });
    const el = await render([]);
    expect(deliveryToggle(el)?.checked).toBe(true);
  });
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
