/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";
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

/**
 * The real DateTimeField is a popover with a lazily imported calendar,
 * and driving it in jsdom means opening the popover, waiting for the
 * module and clicking a day of the current month — none of which is
 * what these tests are about. A plain input carrying the same
 * `testId`/`label`/`value`/`onChange` contract stands in, so a date is
 * set by typing "YYYY-MM-DDTHH:mm" into it. The mocked path is the
 * file, not the barrel: the barrel re-exports it, so GigEdit and
 * ExtraDatesField both get this shim. DateTimeField.test.tsx covers the
 * real control.
 */
vi.mock("../components/DateTimeField.tsx", () => ({
  DateTimeField: ({
    testId,
    label,
    value,
    onChange,
  }: {
    testId?: string;
    label?: string;
    value: string;
    onChange: (v: string) => void;
  }) => (
    <input
      data-testid={testId}
      data-value={value}
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

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

/** Marks which route the save landed on, including the `:id` a
 *  `/gigs/:id` landing carries (same device as PaymentEdit.test.tsx). */
function LandedGig() {
  const { id } = useParams();
  return <div data-testid="landed-gig">{id}</div>;
}

/** `openId` of "new" opens the create form at `/gigs/new`; anything else
 *  opens that gig's edit form. The two landing routes are where a save
 *  navigates to — one gig to its hub, several to the list. */
async function render(all: Gig[], openId: string) {
  ALL = all;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[openId === "new" ? "/gigs/new" : `/gigs/${openId}/edit`]}>
          <HelpProvider>
            <Routes>
              <Route path="/gigs/new" element={<GigEdit />} />
              <Route path="/gigs/:id/edit" element={<GigEdit />} />
              <Route path="/gigs/:id" element={<LandedGig />} />
              <Route path="/gigs" element={<div data-testid="landed-gigs" />} />
            </Routes>
          </HelpProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return container;
}

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
  /** The "Part of" control is a GigPicker (components/GigPicker.tsx):
   *  a trigger on the form, and a sheet portalled to <body> — so the
   *  trigger is found through the render container and the rows
   *  through `document`. */
  const trigger = (el: HTMLElement) =>
    el.querySelector<HTMLButtonElement>('[data-testid="gig-parent-select"]')!;
  const inSheet = <T extends HTMLElement>(id: string) =>
    document.querySelector<T>(`[data-testid="${id}"]`);

  /** What the picker offers: open the sheet, read the row ids, close it
   *  again — the picker's answer to what `<option>`s used to be. */
  async function offered(el: HTMLElement): Promise<string[]> {
    await click(trigger(el));
    const ids = [...document.querySelectorAll<HTMLElement>('[data-testid^="gig-parent-select-row-"]')]
      .map((row) => row.dataset["testid"]!.slice("gig-parent-select-row-".length));
    await click(inSheet("gig-parent-select-sheet-close"));
    return ids;
  }

  /** Pick a parent the way a person does: open the sheet, tap the row. */
  async function pick(el: HTMLElement, id: string) {
    await click(trigger(el));
    await click(inSheet(`gig-parent-select-row-${id}`));
  }

  it("offers a same-client gig that has no parent of its own", async () => {
    const editing = gig({ id: "me", clientId: "c1" });
    const ok = gig({ id: "ok", clientId: "c1", title: "Eligible" });
    const el = await render([editing, ok], "me");
    expect(await offered(el)).toContain("ok");
  });

  it("does not offer the gig being edited", async () => {
    // Mirrors "a gig cannot be its own parent".
    const editing = gig({ id: "me", clientId: "c1" });
    const el = await render([editing], "me");
    expect(await offered(el)).not.toContain("me");
  });

  it("does not offer another client's gig", async () => {
    // Mirrors "parentGigId does not reference the same client".
    const editing = gig({ id: "me", clientId: "c1" });
    const other = gig({ id: "other", clientId: "c2", title: "Bravo's job" });
    const el = await render([editing, other], "me");
    expect(await offered(el)).not.toContain("other");
  });

  it("does not offer a gig that already has a parent", async () => {
    // Mirrors "parentGigId already has a parent of its own" — the rule
    // that keeps the tree one level deep and cycles unreachable.
    const editing = gig({ id: "me", clientId: "c1" });
    const nested = gig({ id: "nested", clientId: "c1", parentGigId: "somewhere" });
    const el = await render([editing, nested], "me");
    expect(await offered(el)).not.toContain("nested");
  });

  it("offers a client-less gig only to another client-less gig", async () => {
    // Both null IS the same client, and `""` is how the form spells null.
    const editing = gig({ id: "me", clientId: null });
    const free = gig({ id: "free", clientId: null, title: "Unattributed" });
    const owned = gig({ id: "owned", clientId: "c1", title: "Acme's" });
    const el = await render([editing, free, owned], "me");
    const ids = await offered(el);
    expect(ids).toContain("free");
    expect(ids).not.toContain("owned");
  });

  it("disables the picker, with a reason, for a gig that has follow-ups", async () => {
    // Rule 5 constrains the gig being EDITED, not the options — a gig
    // with children may not itself become a child, or the stored tree
    // goes two levels deep. Filtering the list cannot say that; an
    // empty list reads as "nothing matches". The reason line is the
    // picker's own (`-blocked`), fed by GigEdit's `disabledReason`.
    const editing = gig({ id: "me", clientId: "c1" });
    const follow = gig({ id: "k", clientId: "c1", title: "Second day", parentGigId: "me" });
    const eligible = gig({ id: "ok", clientId: "c1", title: "Eligible" });
    const el = await render([editing, follow, eligible], "me");

    expect(trigger(el)).not.toBeNull();
    expect(trigger(el).disabled).toBe(true);
    expect(el.querySelector('[data-testid="gig-parent-select-blocked"]')?.textContent).toContain(
      "follow-ups of its own",
    );
    // Disabled means disabled: nothing opens.
    await click(trigger(el));
    expect(inSheet("gig-parent-select-sheet")).toBeNull();
  });

  it("leaves the picker usable, and unexplained, for a gig with no follow-ups", async () => {
    const editing = gig({ id: "me", clientId: "c1" });
    const other = gig({ id: "k", clientId: "c1", title: "Someone else's follow-up", parentGigId: "elsewhere" });
    const el = await render([editing, other], "me");

    expect(trigger(el).disabled).toBe(false);
    expect(el.querySelector('[data-testid="gig-parent-select-blocked"]')).toBeNull();
  });

  it("re-filters when the client changes in the form, not on save", async () => {
    // The candidate list is read off `form.clientId`, not off the stored
    // gig — pick a different client and the list must follow, or the
    // picker keeps offering jobs the server would refuse.
    const editing = gig({ id: "me", clientId: "c1" });
    const acme = gig({ id: "a1", clientId: "c1", title: "Acme's job" });
    const bravo = gig({ id: "b1", clientId: "c2", title: "Bravo's job" });
    const el = await render([editing, acme, bravo], "me");

    expect(await offered(el)).toEqual(["a1"]);

    await choose(el.querySelector<HTMLSelectElement>('[data-testid="gig-client"]')!, "c2");

    expect(await offered(el)).toEqual(["b1"]);
  });

  it("shows the picked parent on the trigger, and saves its id", async () => {
    const editing = gig({ id: "me", clientId: "c1" });
    const acme = gig({ id: "a1", clientId: "c1", title: "Acme's job" });
    const el = await render([editing, acme], "me");

    await pick(el, "a1");
    // Closed after the pick, and the trigger states the choice both
    // canonically and for a person.
    expect(inSheet("gig-parent-select-sheet")).toBeNull();
    expect(trigger(el).dataset["value"]).toBe("a1");
    expect(trigger(el).textContent).toContain("Acme's job");

    await click(el.querySelector('[data-testid="gig-save"]'));
    const [, input] = api.putGig.mock.calls[0]!;
    expect((input as { parentGigId: string | null }).parentGigId).toBe("a1");
  });

  it("drops a selected parent that the new client makes invalid", async () => {
    // A stale selection used to be invisible (a controlled <select>
    // whose value matches no option reads back ""), and the save sent
    // it, to be refused by the server. The picker can SAY the id is not
    // in its list, but that is not a reason to keep sending it. Assert
    // on what is SAVED, not on what the trigger reads back.
    const editing = gig({ id: "me", clientId: "c1" });
    const acme = gig({ id: "a1", clientId: "c1", title: "Acme's job" });
    const bravo = gig({ id: "b1", clientId: "c2", title: "Bravo's job" });
    const el = await render([editing, acme, bravo], "me");

    await pick(el, "a1");
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

});

describe("GigEdit extra dates", () => {
  const byId = <T extends HTMLElement>(el: HTMLElement, id: string) =>
    el.querySelector<T>(`[data-testid="${id}"]`);

  /** What each putGig call was asked to store. */
  function saved(): { dateTime: number | null; batchId: string | null; title: string | null }[] {
    return api.putGig.mock.calls.map(
      ([, input]) => input as { dateTime: number | null; batchId: string | null; title: string | null },
    );
  }

  it("creates one gig per date, all sharing a batch id, and lands on the list", async () => {
    const el = await render([], "new");
    await type(byId<HTMLInputElement>(el, "gig-title")!, "Batch shift");
    await type(byId<HTMLInputElement>(el, "gig-datetime")!, "2026-09-14T09:00");

    // Two "Also on" rows, each given its own day.
    await click(byId(el, "gig-extra-dates-add"));
    await type(byId<HTMLInputElement>(el, "gig-extra-dates-0")!, "2026-09-15T09:00");
    await click(byId(el, "gig-extra-dates-add"));
    await type(byId<HTMLInputElement>(el, "gig-extra-dates-1")!, "2026-09-16T14:30");

    await click(byId(el, "gig-save"));

    expect(api.putGig).toHaveBeenCalledTimes(3);
    const rows = saved();
    // Three different moments, in the order entered.
    expect(rows.map((r) => r.dateTime)).toEqual([
      new Date("2026-09-14T09:00").getTime(),
      new Date("2026-09-15T09:00").getTime(),
      new Date("2026-09-16T14:30").getTime(),
    ]);
    // One batch id, minted once, on all three.
    expect(rows[0]?.batchId).toEqual(expect.any(String));
    expect(new Set(rows.map((r) => r.batchId)).size).toBe(1);
    // Everything else copied.
    expect(rows.map((r) => r.title)).toEqual(["Batch shift", "Batch shift", "Batch shift"]);
    // Distinct gig ids.
    expect(new Set(api.putGig.mock.calls.map(([id]) => id)).size).toBe(3);
    // No single "the gig" to open: the list.
    expect(byId(el, "landed-gigs")).not.toBeNull();
  });

  it("leaves batchId null for one date, and opens that gig", async () => {
    const el = await render([], "new");
    await type(byId<HTMLInputElement>(el, "gig-datetime")!, "2026-09-14T09:00");
    // An opened-and-never-filled row is not a second gig.
    await click(byId(el, "gig-extra-dates-add"));

    await click(byId(el, "gig-save"));

    expect(api.putGig).toHaveBeenCalledTimes(1);
    expect(saved()[0]?.batchId).toBeNull();
    const [createdId] = api.putGig.mock.calls[0]!;
    expect(byId(el, "landed-gig")?.textContent).toBe(createdId);
  });

  it("refuses two rows on the same moment, and writes nothing", async () => {
    const el = await render([], "new");
    await type(byId<HTMLInputElement>(el, "gig-datetime")!, "2026-09-14T09:00");
    await click(byId(el, "gig-extra-dates-add"));
    await type(byId<HTMLInputElement>(el, "gig-extra-dates-0")!, "2026-09-14T09:00");

    await click(byId(el, "gig-save"));

    expect(api.putGig).not.toHaveBeenCalled();
    expect(byId(el, "gig-date-error")?.textContent).toBe(
      "Two of the dates are the same — remove one.",
    );
    // Still on the form.
    expect(byId(el, "gig-save")).not.toBeNull();
  });

  it("offers no extra-date rows when editing an existing gig", async () => {
    // Batches are made at creation only: an existing gig is one record
    // with one date, and "Save gig" on it must not create others.
    const el = await render([gig({ id: "me" })], "me");
    expect(byId(el, "gig-datetime")).not.toBeNull();
    expect(byId(el, "gig-extra-dates")).toBeNull();
    expect(byId(el, "gig-extra-dates-add")).toBeNull();
  });
});

describe("GigEdit parent picker (saved parent)", () => {
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
