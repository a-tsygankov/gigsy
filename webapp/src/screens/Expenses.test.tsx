/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Expenses } from "./Expenses.tsx";
import type { Expense } from "../lib/types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Same reasoning as money/Payments.test.tsx: React Query's default
// scheduler defers notifications to a real macrotask, which a plain
// `await act(async () => render())` never observes.
notifyManager.setScheduler((cb) => cb());

const EXPENSES: Expense[] = [
  {
    id: "e1",
    gigId: null,
    amountCents: 4250,
    category: "Parking",
    receiptR2Key: null,
    notes: null,
    reimbursable: false,
    createdAt: Date.UTC(2026, 7, 1),
    modifiedAt: 0,
  },
];

const api = {
  listExpenses: vi.fn(async () => EXPENSES),
};

// The screen reaches the data service through useData(); this replaces
// it rather than standing up a real Dexie stack for a rendering test.
vi.mock("../lib/app-context.tsx", () => ({
  useData: () => api,
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
        <MemoryRouter initialEntries={["/expenses"]}>
          <Expenses />
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

describe("Expenses", () => {
  it("shows a loading skeleton while the query is pending", async () => {
    // Never resolves within this test — the point is to catch the
    // component mid-flight, not to assert on the eventual data.
    api.listExpenses.mockReturnValueOnce(new Promise(() => {}));
    const el = await render();
    expect(el.querySelector('[data-testid="skeleton"]')).not.toBeNull();
  });

  it("shows a dedicated empty state when there are no expenses at all", async () => {
    api.listExpenses.mockResolvedValueOnce([]);
    const el = await render();
    expect(el.textContent).toContain("No expenses yet");
    expect(el.textContent).toContain(
      "Parking, supplies, mileage — track what gigs really cost.",
    );
    expect(el.querySelector('a[href="/expenses/new"]')).not.toBeNull();
  });

  it("lists a row with its category and formatted amount", async () => {
    const el = await render();
    const list = el.querySelector('[data-testid="expense-list"]');
    expect(list).not.toBeNull();
    expect(list!.textContent).toContain("Parking");
    expect(list!.textContent).toContain("42.50");
    const link = el.querySelector('a[href="/expenses/e1"]');
    expect(link).not.toBeNull();
  });

  it("offers to add an expense", async () => {
    const el = await render();
    const fab = el.querySelector('[data-testid="expense-add"]');
    expect(fab?.getAttribute("href")).toBe("/expenses/new");
  });
});
