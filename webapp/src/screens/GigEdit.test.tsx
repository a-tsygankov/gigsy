/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GigEdit } from "./GigEdit.tsx";
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
const BRAVO: Client = {
  id: "c2", name: "Bravo", contactInfo: null, notes: null, createdAt: 0, modifiedAt: 0,
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
  listClients: vi.fn(async () => [ACME, BRAVO]),
  putGig: vi.fn(async (id: string, input: unknown) => ({ ...gig({ id }), ...(input as object) })),
  reverseGeocode: vi.fn(async () => ({ label: null })),
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
        <MemoryRouter initialEntries={[`/gigs/${openId}/edit`]}>
          <HelpProvider>
            <Routes>
              <Route path="/gigs/:id/edit" element={<GigEdit />} />
            </Routes>
          </HelpProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return container;
}

/** Drive a native <select> the way React hears it: through the
 *  prototype's value setter, so React's change tracking does not
 *  swallow the event as a no-op. */
async function choose(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLSelectElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setter.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.clearAllMocks();
});

describe("GigEdit parent picker", () => {
  function options(el: HTMLElement): string[] {
    const select = el.querySelector('[data-testid="gig-parent-select"]');
    return [...(select?.querySelectorAll("option") ?? [])]
      .map((o) => o.getAttribute("value") ?? "")
      .filter((v) => v !== "");
  }

  it("offers a same-client gig that has no parent of its own", async () => {
    const editing = gig({ id: "me", clientId: "c1" });
    const ok = gig({ id: "ok", clientId: "c1", title: "Eligible" });
    const el = await render([editing, ok], "me");
    expect(options(el)).toContain("ok");
  });

  it("does not offer the gig being edited", async () => {
    // Mirrors "a gig cannot be its own parent".
    const editing = gig({ id: "me", clientId: "c1" });
    const el = await render([editing], "me");
    expect(options(el)).not.toContain("me");
  });

  it("does not offer another client's gig", async () => {
    // Mirrors "parentGigId does not reference the same client".
    const editing = gig({ id: "me", clientId: "c1" });
    const other = gig({ id: "other", clientId: "c2", title: "Bravo's job" });
    const el = await render([editing, other], "me");
    expect(options(el)).not.toContain("other");
  });

  it("does not offer a gig that already has a parent", async () => {
    // Mirrors "parentGigId already has a parent of its own" — the rule
    // that keeps the tree one level deep and cycles unreachable.
    const editing = gig({ id: "me", clientId: "c1" });
    const nested = gig({ id: "nested", clientId: "c1", parentGigId: "somewhere" });
    const el = await render([editing, nested], "me");
    expect(options(el)).not.toContain("nested");
  });

  it("offers a client-less gig only to another client-less gig", async () => {
    // Both null IS the same client, and `""` is how the form spells null.
    const editing = gig({ id: "me", clientId: null });
    const free = gig({ id: "free", clientId: null, title: "Unattributed" });
    const owned = gig({ id: "owned", clientId: "c1", title: "Acme's" });
    const el = await render([editing, free, owned], "me");
    expect(options(el)).toContain("free");
    expect(options(el)).not.toContain("owned");
  });

  it("disables the picker, with a reason, for a gig that has follow-ups", async () => {
    // Rule 5 constrains the gig being EDITED, not the options — a gig
    // with children may not itself become a child, or the stored tree
    // goes two levels deep. Filtering the list cannot say that; an
    // empty dropdown reads as "nothing matches".
    const editing = gig({ id: "me", clientId: "c1" });
    const follow = gig({ id: "k", clientId: "c1", title: "Second day", parentGigId: "me" });
    const eligible = gig({ id: "ok", clientId: "c1", title: "Eligible" });
    const el = await render([editing, follow, eligible], "me");

    const select = el.querySelector<HTMLSelectElement>('[data-testid="gig-parent-select"]');
    expect(select).not.toBeNull();
    expect(select?.disabled).toBe(true);
    expect(el.querySelector('[data-testid="gig-parent-blocked"]')).not.toBeNull();
  });

  it("leaves the picker usable, and unexplained, for a gig with no follow-ups", async () => {
    const editing = gig({ id: "me", clientId: "c1" });
    const other = gig({ id: "k", clientId: "c1", title: "Someone else's follow-up", parentGigId: "elsewhere" });
    const el = await render([editing, other], "me");

    const select = el.querySelector<HTMLSelectElement>('[data-testid="gig-parent-select"]');
    expect(select?.disabled).toBe(false);
    expect(el.querySelector('[data-testid="gig-parent-blocked"]')).toBeNull();
  });

  it("re-filters when the client changes in the form, not on save", async () => {
    // The option list is read off `form.clientId`, not off the stored
    // gig — pick a different client and the list must follow, or the
    // picker keeps offering jobs the server would refuse.
    const editing = gig({ id: "me", clientId: "c1" });
    const acme = gig({ id: "a1", clientId: "c1", title: "Acme's job" });
    const bravo = gig({ id: "b1", clientId: "c2", title: "Bravo's job" });
    const el = await render([editing, acme, bravo], "me");

    expect(options(el)).toEqual(["a1"]);

    await choose(el.querySelector<HTMLSelectElement>('[data-testid="gig-client"]')!, "c2");

    expect(options(el)).toEqual(["b1"]);
  });

  it("drops a selected parent that the new client makes invalid", async () => {
    // A stale selection is invisible: a controlled <select> whose value
    // matches no option reports "" from the DOM, so the box looks empty
    // while the form still holds the old id — and the save sends it, to
    // be refused by the server. Assert on what is SAVED, not on what
    // the select reads back.
    const editing = gig({ id: "me", clientId: "c1" });
    const acme = gig({ id: "a1", clientId: "c1", title: "Acme's job" });
    const bravo = gig({ id: "b1", clientId: "c2", title: "Bravo's job" });
    const el = await render([editing, acme, bravo], "me");

    await choose(el.querySelector<HTMLSelectElement>('[data-testid="gig-parent-select"]')!, "a1");
    await choose(el.querySelector<HTMLSelectElement>('[data-testid="gig-client"]')!, "c2");

    const save = el.querySelector<HTMLButtonElement>('[data-testid="gig-save"]')!;
    await act(async () => {
      save.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(api.putGig).toHaveBeenCalledTimes(1);
    const [, input] = api.putGig.mock.calls[0]!;
    expect((input as { clientId: string | null }).clientId).toBe("c2");
    expect((input as { parentGigId: string | null }).parentGigId).toBeNull();
  });

  it("keeps a saved parent the local gig list has not caught up with", async () => {
    // The clearing rule above must fire on a user edit, never on an
    // absence of local knowledge. A parent this device has not pulled
    // yet is not in `parentOptions` either — and "clear anything not in
    // the options" would silently unlink the gig on the next save.
    const editing = gig({ id: "me", clientId: "c1", parentGigId: "ghost" });
    const el = await render([editing], "me");

    const save = el.querySelector<HTMLButtonElement>('[data-testid="gig-save"]')!;
    await act(async () => {
      save.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const [, input] = api.putGig.mock.calls[0]!;
    expect((input as { parentGigId: string | null }).parentGigId).toBe("ghost");
  });
});
