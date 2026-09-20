/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";
import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DraftReview } from "./DraftReview.tsx";
import { HelpProvider } from "../help/runtime/HelpProvider.tsx";
import { NEW_CLIENT_OPTION } from "../components/ClientSelect.tsx";
import { msToLocalInput } from "../lib/datetime.ts";
import type { Client, Draft, DraftExtracted, Gig, GigInput } from "../lib/types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// TanStack Query v5 schedules the re-render through a real
// setTimeout(fn, 0). `await act` drains only microtasks, so without
// this the assertions race the timer and the file is non-deterministic.
notifyManager.setScheduler((cb) => cb());

/**
 * The same shim GigEdit.test.tsx uses: the real DateTimeField is a
 * popover with a lazily imported calendar, and what these tests read is
 * which dates the rows HOLD — readable off the shim's `data-value`
 * without opening anything. Mocked by file path so the barrel's
 * re-export (which DraftReview and ExtraDatesField both import through)
 * resolves to it.
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
  id: "c1", name: "Acme", contactInfo: null, notes: null, needsDelivery: false, createdAt: 0, modifiedAt: 0,
};

// Three local moments, as epoch ms — what extraction hands back.
const MON = new Date("2026-09-14T09:00").getTime();
const TUE = new Date("2026-09-15T09:00").getTime();
const WED = new Date("2026-09-16T14:30").getTime();

function draft(extracted: Partial<DraftExtracted>): Draft {
  return {
    id: "d1",
    source: "photo",
    // No raw key, so the screen never asks for the photo blob — the
    // preview is not what these tests are about.
    rawR2Key: null,
    status: "pending",
    extracted: {
      kind: "gig",
      clientName: "Acme",
      matchedClientId: "c1",
      matchConfidence: 0.9,
      location: "Expo Hall",
      amountOfferedCents: 12500,
      notes: null,
      ...extracted,
    },
    createdAt: 0,
    modifiedAt: 0,
  };
}

let DRAFT: Draft = draft({});

const api = {
  getDraft: vi.fn(async () => DRAFT),
  listClients: vi.fn(async () => [ACME]),
  putGig: vi.fn(
    async (id: string, input: GigInput): Promise<Gig> => ({
      id,
      clientId: input.clientId ?? null,
      parentGigId: null,
      batchId: input.batchId ?? null,
      title: null,
      status: "lead",
      location: input.location ?? null,
      dateTime: input.dateTime ?? null,
      durationMinutes: null,
      payType: "fixed",
      hourlyRateCents: null,
      workStartedAt: null,
      workEndedAt: null,
      breakMinutes: null,
      calendarEventId: null,
      amountOfferedCents: input.amountOfferedCents ?? null,
      amountPaidCents: null,
      expectedCents: null,
      notes: null,
      source: "photo",
      createdAt: 0,
      modifiedAt: 0,
    }),
  ),
  putClient: vi.fn(async (id: string, input: { name: string }) => ({ ...ACME, id, ...input })),
  setDraftStatus: vi.fn(async () => DRAFT),
  getDraftRawBlob: vi.fn(async () => null),
};

vi.mock("../lib/app-context.tsx", () => ({
  useData: () => api,
  useSyncState: () => ({ online: true, pendingCount: 0 }),
  useServices: () => ({ ready: true }),
  useAuthState: () => ({ user: { email: "t@e.com" }, ready: true, signedIn: true }),
  useSyncEngine: () => null,
}));

/** Marks which route the confirm landed on, including the `:id` a
 *  `/gigs/:id` landing carries. */
function LandedGig() {
  const { id } = useParams();
  return <div data-testid="landed-gig">{id}</div>;
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function render(d: Draft) {
  DRAFT = d;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/drafts/d1"]}>
          <HelpProvider>
            <Routes>
              <Route path="/drafts/:id" element={<DraftReview />} />
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

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.clearAllMocks();
});

const byId = <T extends HTMLElement>(el: HTMLElement, id: string) =>
  el.querySelector<T>(`[data-testid="${id}"]`);

async function click(el: Element | null) {
  await act(async () => {
    el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/** Drive a native <select> the way React hears it: through the
 *  prototype's value setter, so React's change tracking does not
 *  swallow the event as a no-op (same device as GigEdit.test.tsx). */
async function choose(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** What each putGig call was asked to store. */
function saved(): { dateTime: number | null; batchId: string | null }[] {
  return api.putGig.mock.calls.map(([, input]) => ({
    dateTime: input.dateTime ?? null,
    batchId: input.batchId ?? null,
  }));
}

describe("DraftReview gig dates", () => {
  it("seeds the primary date and one Also-on row per further date", async () => {
    const el = await render(draft({ dateTimeMs: MON, dateTimesMs: [MON, TUE, WED] }));

    expect(byId(el, "draft-datetime")?.dataset["value"]).toBe(msToLocalInput(MON));
    expect(byId(el, "draft-extra-dates-0")?.dataset["value"]).toBe(msToLocalInput(TUE));
    expect(byId(el, "draft-extra-dates-1")?.dataset["value"]).toBe(msToLocalInput(WED));
    expect(byId(el, "draft-extra-dates-2")).toBeNull();
  });

  it("confirms one gig per date, all in one batch, closing the draft once", async () => {
    const el = await render(draft({ dateTimeMs: MON, dateTimesMs: [MON, TUE, WED] }));

    await click(byId(el, "draft-confirm"));

    expect(api.putGig).toHaveBeenCalledTimes(3);
    const rows = saved();
    expect(rows.map((r) => r.dateTime)).toEqual([MON, TUE, WED]);
    expect(rows[0]?.batchId).toEqual(expect.any(String));
    expect(new Set(rows.map((r) => r.batchId)).size).toBe(1);
    // Every sibling got the matched client and the extracted fee.
    for (const [, input] of api.putGig.mock.calls) {
      expect(input.clientId).toBe("c1");
      expect(input.amountOfferedCents).toBe(12500);
      expect(input.source).toBe("photo");
    }
    // The draft closes ONCE, after all of them.
    expect(api.setDraftStatus).toHaveBeenCalledTimes(1);
    expect(api.setDraftStatus).toHaveBeenCalledWith("d1", "confirmed");
    // Several gigs: no single one to open, so the list.
    expect(byId(el, "landed-gigs")).not.toBeNull();
  });

  it("reads an older draft with only dateTimeMs as one gig, batchId null", async () => {
    // Drafts extracted before `dateTimesMs` existed (and the stub) name
    // one date the old way. No rows, one gig, no batch.
    const el = await render(draft({ dateTimeMs: MON }));

    expect(byId(el, "draft-datetime")?.dataset["value"]).toBe(msToLocalInput(MON));
    expect(byId(el, "draft-extra-dates-0")).toBeNull();

    await click(byId(el, "draft-confirm"));

    expect(api.putGig).toHaveBeenCalledTimes(1);
    expect(saved()[0]).toEqual({ dateTime: MON, batchId: null });
    expect(api.setDraftStatus).toHaveBeenCalledWith("d1", "confirmed");
    const [createdId] = api.putGig.mock.calls[0]!;
    expect(byId(el, "landed-gig")?.textContent).toBe(createdId);
  });

  it("falls back to dateTimeMs when dateTimesMs is present but empty", async () => {
    // The provider may return `[]` for a document with no dates it could
    // read; that must not become "no primary date" when dateTimeMs has
    // one.
    const el = await render(draft({ dateTimeMs: MON, dateTimesMs: [] }));
    expect(byId(el, "draft-datetime")?.dataset["value"]).toBe(msToLocalInput(MON));
    expect(byId(el, "draft-extra-dates-0")).toBeNull();
  });

  it("refuses two rows on the same moment without writing or closing anything", async () => {
    const el = await render(draft({ dateTimeMs: MON, dateTimesMs: [MON, MON] }));

    await click(byId(el, "draft-confirm"));

    expect(api.putGig).not.toHaveBeenCalled();
    expect(api.setDraftStatus).not.toHaveBeenCalled();
    expect(el.textContent).toContain("Two of the dates are the same — remove one.");
  });
});

describe("DraftReview client match", () => {
  const clientSelect = (el: HTMLElement) => byId<HTMLSelectElement>(el, "draft-client")!;
  const nameBox = (el: HTMLElement) => byId<HTMLInputElement>(el, "draft-client-new-name");
  const confirmButton = (el: HTMLElement) => byId<HTMLButtonElement>(el, "draft-confirm")!;
  const savedClientIds = () => api.putGig.mock.calls.map(([, input]) => input.clientId ?? null);

  describe("confident band (≥ 0.9)", () => {
    it("announces the match, preselects it, and asks nothing", async () => {
      const el = await render(draft({ matchedClientId: "c1", matchConfidence: 0.97 }));

      expect(byId(el, "match-banner")?.textContent).toContain("Matched existing client: Acme");
      expect(byId(el, "match-banner")?.textContent).toContain("(97%)");
      expect(byId(el, "match-question")).toBeNull();
      expect(byId(el, "draft-match-pending")).toBeNull();
      expect(clientSelect(el).value).toBe("c1");
      expect(confirmButton(el).disabled).toBe(false);
    });

    it("confirms with the matched id and creates no client", async () => {
      const el = await render(draft({ matchedClientId: "c1", matchConfidence: 1, dateTimeMs: MON }));
      await click(confirmButton(el));
      expect(api.putClient).not.toHaveBeenCalled();
      expect(savedClientIds()).toEqual(["c1"]);
    });

    it("drops the banner once the person points the select elsewhere", async () => {
      // The band is evidence; the banner is a claim about the CHOICE.
      const el = await render(draft({ matchedClientId: "c1", matchConfidence: 1 }));
      await choose(clientSelect(el), "");
      expect(byId(el, "match-banner")).toBeNull();
      await click(confirmButton(el));
      expect(savedClientIds()).toEqual([null]);
    });
  });

  describe("unsure band (< 0.9)", () => {
    const unsure = draft({ matchedClientId: "c1", matchConfidence: 0.8, clientName: "ACME LLC" });

    it("asks, preselects nothing, and holds Confirm until answered", async () => {
      const el = await render(unsure);

      expect(byId(el, "match-question")?.textContent).toContain("Looks like Acme — is that right?");
      expect(byId(el, "draft-match-yes")?.textContent).toBe("Yes, it's Acme");
      expect(byId(el, "draft-match-no")?.textContent).toBe('No, new client "ACME LLC"');
      expect(byId(el, "match-banner")).toBeNull();
      expect(clientSelect(el).value).toBe("");
      expect(confirmButton(el).disabled).toBe(true);
      expect(byId(el, "draft-match-pending")?.textContent).toBe("Answer the client question first.");

      // Disabled means disabled: a click writes nothing.
      await click(confirmButton(el));
      expect(api.putGig).not.toHaveBeenCalled();
    });

    it("Yes links the matched client and releases Confirm", async () => {
      const el = await render(unsure);
      await click(byId(el, "draft-match-yes"));

      expect(byId(el, "match-question")).toBeNull();
      expect(byId(el, "draft-match-pending")).toBeNull();
      expect(clientSelect(el).value).toBe("c1");
      expect(confirmButton(el).disabled).toBe(false);

      await click(confirmButton(el));
      expect(api.putClient).not.toHaveBeenCalled();
      expect(savedClientIds()).toEqual(["c1"]);
    });

    it("No creates a client spelt as the document had it", async () => {
      const el = await render(unsure);
      await click(byId(el, "draft-match-no"));

      expect(byId(el, "match-question")).toBeNull();
      expect(clientSelect(el).value).toBe(NEW_CLIENT_OPTION);
      expect(nameBox(el)?.value).toBe("ACME LLC");
      expect(byId(el, "match-banner")?.textContent).toContain("New client will be created: ACME LLC");
      expect(confirmButton(el).disabled).toBe(false);

      await click(confirmButton(el));
      expect(api.putClient).toHaveBeenCalledTimes(1);
      expect(api.putClient).toHaveBeenCalledWith(expect.any(String), { name: "ACME LLC" });
      expect(savedClientIds()).toEqual([api.putClient.mock.calls[0]![0]]);
    });

    it("a hand-picked client answers the question too", async () => {
      const el = await render(unsure);
      await choose(clientSelect(el), "c1");
      expect(byId(el, "match-question")).toBeNull();
      expect(confirmButton(el).disabled).toBe(false);
    });

    it("the question does not gate an expense", async () => {
      // The client is a gig's field; switching kind takes the question
      // (and the gate) off the screen with it.
      const el = await render(unsure);
      const kindSelect = el.querySelector<HTMLSelectElement>("select")!;
      await choose(kindSelect, "expense");
      expect(byId(el, "match-question")).toBeNull();
      expect(byId(el, "draft-match-pending")).toBeNull();
      expect(confirmButton(el).disabled).toBe(false);
    });
  });

  describe("none band", () => {
    it("preselects New client with the extracted name, and creates it on confirm", async () => {
      const el = await render(
        draft({ matchedClientId: null, matchConfidence: null, clientName: "Full Field Agency" }),
      );

      expect(byId(el, "match-question")).toBeNull();
      expect(clientSelect(el).value).toBe(NEW_CLIENT_OPTION);
      expect(nameBox(el)?.value).toBe("Full Field Agency");
      expect(byId(el, "match-banner")?.textContent).toContain(
        "New client will be created: Full Field Agency",
      );
      expect(confirmButton(el).disabled).toBe(false);

      await click(confirmButton(el));
      expect(api.putClient).toHaveBeenCalledWith(expect.any(String), { name: "Full Field Agency" });
      expect(savedClientIds()).toEqual([api.putClient.mock.calls[0]![0]]);
    });

    it("follows an edited name into the banner and the client row", async () => {
      const el = await render(draft({ matchedClientId: null, clientName: "FFA" }));
      await type(nameBox(el)!, "Full Field Agency");
      expect(byId(el, "match-banner")?.textContent).toContain("Full Field Agency");
      await click(confirmButton(el));
      expect(api.putClient).toHaveBeenCalledWith(expect.any(String), { name: "Full Field Agency" });
    });

    it("selects nothing, shows no banner and creates no client when no name was read", async () => {
      const el = await render(draft({ matchedClientId: null, clientName: null }));
      expect(byId(el, "match-banner")).toBeNull();
      expect(clientSelect(el).value).toBe("");
      expect(nameBox(el)).toBeNull();

      await click(confirmButton(el));
      expect(api.putClient).not.toHaveBeenCalled();
      expect(savedClientIds()).toEqual([null]);
    });

    it("refuses a new client whose name was cleared, writing nothing", async () => {
      const el = await render(draft({ matchedClientId: null, clientName: "FFA" }));
      await type(nameBox(el)!, "  ");
      await click(confirmButton(el));
      expect(api.putClient).not.toHaveBeenCalled();
      expect(api.putGig).not.toHaveBeenCalled();
      expect(api.setDraftStatus).not.toHaveBeenCalled();
      expect(el.textContent).toContain("Give the new client a name.");
    });

    it("does not create a client for a draft whose dates are refused", async () => {
      // Dates are checked before the client is written, so a refused
      // draft leaves no orphan client behind.
      const el = await render(
        draft({ matchedClientId: null, clientName: "FFA", dateTimeMs: MON, dateTimesMs: [MON, MON] }),
      );
      await click(confirmButton(el));
      expect(api.putClient).not.toHaveBeenCalled();
      expect(api.putGig).not.toHaveBeenCalled();
    });
  });
});
