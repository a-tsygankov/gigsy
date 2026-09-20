/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExpenseEdit } from "./ExpenseEdit.tsx";
import { HelpProvider } from "../help/runtime/HelpProvider.tsx";
import type { Client, Expense, Gig } from "../lib/types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// TanStack Query v5 schedules the re-render through a real
// setTimeout(fn, 0). `await act` drains only microtasks, so without
// this the assertions race the timer and the file is non-deterministic.
notifyManager.setScheduler((cb) => cb());

const ACME: Client = {
  id: "c1", name: "Acme", contactInfo: null, notes: null, needsDelivery: false, createdAt: 0, modifiedAt: 0,
};

function gig(over: Partial<Gig>): Gig {
  return {
    id: "g1",
    clientId: "c1",
    parentGigId: null,
    batchId: null,
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
    amountPaidCents: null,
    expectedCents: null,
    notes: null,
    source: null,
    createdAt: 0,
    modifiedAt: 0,
    ...over,
  };
}

const TASTING = gig({ id: "g1", title: "Arrange a tasting", location: "Soho" });
const PROMO = gig({ id: "g2", title: "Promo shift" });

const EXPENSE: Expense = {
  id: "e1",
  gigId: "g1",
  amountCents: 2350,
  category: "parking",
  receiptR2Key: null,
  notes: null,
  reimbursable: false,
  createdAt: 0,
  modifiedAt: 0,
};

const api = {
  getExpense: vi.fn(async () => EXPENSE),
  listGigs: vi.fn(async () => [TASTING, PROMO]),
  listClients: vi.fn(async () => [ACME]),
  // The linked-gig picker asks `useSettings` for `clientsExpectDelivery`
  // (lib/gig-delivery.ts); nothing else on this form reads settings.
  getSettings: vi.fn(async () => ({ clientsExpectDelivery: false })),
  putExpense: vi.fn(async (id: string, input: object) => ({ ...EXPENSE, id, ...input })),
  deleteExpense: vi.fn(async () => undefined),
};

vi.mock("../lib/app-context.tsx", () => ({
  useData: () => api,
  useSyncState: () => ({ online: true, pendingCount: 0 }),
  // Pulled in only because this screen renders AppHeader, which reads
  // these directly — ExpenseEdit itself never touches them.
  useServices: () => ({ auth: {}, ready: true }),
  useAuthState: () => ({ user: { email: "t@e.com" }, ready: true, signedIn: true }),
  useSyncEngine: () => null,
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

/** "new" opens the create form; anything else opens that expense. */
async function render(openId: string) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[`/expenses/${openId}`]}>
          <HelpProvider>
            <Routes>
              <Route path="/expenses/:id" element={<ExpenseEdit />} />
              <Route path="/expenses" element={<div data-testid="landed-expenses" />} />
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

/** Type into a text input the way React hears it: through the
 *  prototype's value setter and the native "input" event. */
async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(el: Element | null) {
  await act(async () => {
    el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

const byId = <T extends HTMLElement>(el: HTMLElement, id: string) =>
  el.querySelector<T>(`[data-testid="${id}"]`);
/** The picker's sheet is portalled to <body>, past the render container. */
const inSheet = <T extends HTMLElement>(id: string) =>
  document.querySelector<T>(`[data-testid="${id}"]`);

/** What the last putExpense was asked to store. */
function saved(): { gigId: string | null } {
  const [, input] = api.putExpense.mock.calls.at(-1)!;
  return input as { gigId: string | null };
}

describe("ExpenseEdit linked gig", () => {
  it("starts unlinked on a new expense, and offers every gig", async () => {
    const el = await render("new");
    const trigger = byId<HTMLButtonElement>(el, "expense-gig")!;
    expect(trigger.dataset["value"]).toBe("");
    expect(trigger.textContent).toContain("Not linked");

    await click(trigger);
    // No narrowing here, unlike the parent picker: an expense may
    // belong to any gig at all.
    expect(inSheet("expense-gig-row-g1")).not.toBeNull();
    expect(inSheet("expense-gig-row-g2")).not.toBeNull();
    expect(inSheet("expense-gig-none")?.textContent).toBe("Not linked");
  });

  it("picks a gig through the sheet and saves its id", async () => {
    const el = await render("new");
    await type(byId<HTMLInputElement>(el, "expense-amount")!, "12.50");

    await click(byId(el, "expense-gig"));
    await click(inSheet("expense-gig-row-g2"));
    // Closed, and the trigger says which gig — as the Gigs tab would.
    expect(inSheet("expense-gig-sheet")).toBeNull();
    const trigger = byId<HTMLButtonElement>(el, "expense-gig")!;
    expect(trigger.dataset["value"]).toBe("g2");
    expect(trigger.textContent).toContain("Promo shift");

    await click(byId(el, "expense-save"));
    expect(api.putExpense).toHaveBeenCalledTimes(1);
    expect(saved().gigId).toBe("g2");
    expect(byId(el, "landed-expenses")).not.toBeNull();
  });

  it("shows the stored gig on an existing expense", async () => {
    const el = await render("e1");
    const trigger = byId<HTMLButtonElement>(el, "expense-gig")!;
    expect(trigger.dataset["value"]).toBe("g1");
    expect(trigger.textContent).toContain("Arrange a tasting");
    expect(trigger.textContent).toContain("Soho");
  });

  it("clears the link from the sheet's none row, and saves null", async () => {
    const el = await render("e1");
    await click(byId(el, "expense-gig"));
    // The current choice is marked among the rows.
    expect(inSheet("expense-gig-row-g1")?.getAttribute("aria-pressed")).toBe("true");
    await click(inSheet("expense-gig-none"));

    expect(byId<HTMLButtonElement>(el, "expense-gig")!.dataset["value"]).toBe("");
    await click(byId(el, "expense-save"));
    // Null, not "": the form spells "no gig" as "" and the record as null.
    expect(saved().gigId).toBeNull();
  });
});
