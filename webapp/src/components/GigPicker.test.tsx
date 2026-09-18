/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GigPicker, type GigPickerProps } from "./GigPicker.tsx";
import type { Client, Gig } from "../lib/types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
    dateTime: new Date(2026, 8, 12, 14, 0).getTime(),
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

const TASTING = gig({ id: "g1", title: "Arrange a tasting", clientId: "c1", location: "Soho" });
const PROMO = gig({ id: "g2", title: "Promo shift", clientId: "c2", status: "lead" });
const GIGS = [TASTING, PROMO];

let container: HTMLDivElement | null = null;
let root: Root | null = null;

/** The sheet is portalled to <body>, so lookups go through `document`. */
const byId = <T extends HTMLElement>(id: string): T | null =>
  document.querySelector<T>(`[data-testid="${id}"]`);

function unmount() {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
}

function render(over: Partial<GigPickerProps> = {}): HTMLDivElement {
  // A test that renders twice must not leave the first tree behind:
  // the trigger lookup below would find the stale one.
  unmount();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <MemoryRouter>
        <GigPicker
          gigs={GIGS}
          clients={[ACME, BRAVO]}
          value=""
          onChange={() => {}}
          testId="p"
          label="Linked gig"
          placeholder="Not linked"
          {...over}
        />
      </MemoryRouter>,
    ),
  );
  return container;
}

const trigger = () => container!.querySelector<HTMLButtonElement>('[data-testid="p"]')!;
const click = (el: HTMLElement | null) => act(() => el!.click());
const open = () => click(trigger());

/** Type into a text input the way React hears it: through the
 *  prototype's value setter and the native "input" event. */
function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** The ids of the gig rows currently listed in the open sheet. */
function listedIds(): string[] {
  return [...document.querySelectorAll<HTMLElement>('[data-testid^="p-row-"]')].map(
    (el) => el.dataset["testid"]!.slice("p-row-".length),
  );
}

afterEach(unmount);

describe("GigPicker trigger", () => {
  it("shows the placeholder, and no gig, when nothing is chosen", () => {
    render();
    expect(trigger().textContent).toContain("Not linked");
    expect(trigger().dataset["value"]).toBe("");
    expect(trigger().querySelector('[data-testid="status-pill"]')).toBeNull();
  });

  it("shows the chosen gig's heading, client, date and pill", () => {
    render({ value: "g1" });
    expect(trigger().dataset["value"]).toBe("g1");
    expect(trigger().textContent).toContain("Arrange a tasting");
    expect(trigger().textContent).toContain("Acme · Sat, Sep 12, 2:00 PM · Soho");
    expect(trigger().querySelector('[data-testid="status-pill"]')?.textContent).toBe("confirmed");
    expect(trigger().textContent).not.toContain("Not linked");
  });

  it("puts BOTH the label and the choice in the accessible name", () => {
    render({ value: "g1" });
    const name = trigger().getAttribute("aria-label") ?? "";
    expect(name).toContain("Linked gig");
    expect(name).toContain("Arrange a tasting");
    expect(name).toContain("Acme");
    render({ value: "" });
    expect(trigger().getAttribute("aria-label")).toBe("Linked gig, Not linked");
  });

  it("keeps an id the candidate list does not hold, and says so", () => {
    // A saved parent this device has not pulled yet must survive the
    // round trip (GigEdit.test.tsx's "ghost" case) — so the value stays
    // and the trigger states something true rather than the placeholder.
    render({ value: "ghost" });
    expect(trigger().dataset["value"]).toBe("ghost");
    expect(trigger().textContent).not.toContain("Not linked");
    expect(trigger().textContent).toContain("hasn't loaded yet");
  });

  it("is a plain button that never submits the form around it", () => {
    render();
    expect(trigger().type).toBe("button");
    expect(trigger().getAttribute("aria-haspopup")).toBe("dialog");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("is disabled, with the reason underneath, when a reason is given", () => {
    render({ disabledReason: "This job has follow-ups of its own." });
    expect(trigger().disabled).toBe(true);
    expect(byId("p-blocked")?.textContent).toBe("This job has follow-ups of its own.");
    click(trigger());
    expect(byId("p-sheet")).toBeNull();
  });

  it("shows no reason line, and is enabled, without one", () => {
    render({ disabledReason: null });
    expect(trigger().disabled).toBe(false);
    expect(byId("p-blocked")).toBeNull();
  });
});

describe("GigPicker sheet", () => {
  it("keeps the list behind the trigger until it is opened", () => {
    render();
    expect(byId("p-sheet")).toBeNull();
    expect(byId("p-list")).toBeNull();
    open();
    expect(byId("p-sheet")).not.toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
  });

  it("is headed by the label and lists every candidate with the tab's filter bar", () => {
    render();
    open();
    const sheet = byId("p-sheet")!;
    expect(sheet.querySelector("h2")?.textContent).toBe("Linked gig");
    expect(sheet.querySelector('[data-testid="gig-filters"]')).not.toBeNull();
    expect(listedIds()).toEqual(["g1", "g2"]);
    // Each row reads like the tab's row, not like the old one-line option.
    expect(byId("p-row-g1")?.textContent).toContain("Arrange a tasting");
    expect(byId("p-row-g1")?.textContent).toContain("Acme · Sat, Sep 12, 2:00 PM · Soho");
    expect(byId("p-row-g2")?.querySelector('[data-testid="status-pill"]')?.textContent).toBe("lead");
  });

  it("marks the current choice among the rows", () => {
    render({ value: "g2" });
    open();
    expect(byId("p-row-g2")?.getAttribute("aria-pressed")).toBe("true");
    expect(byId("p-row-g1")?.getAttribute("aria-pressed")).toBe("false");
    expect(byId("p-none")?.getAttribute("aria-pressed")).toBe("false");
  });

  it("narrows the list as the search box is typed into", () => {
    render();
    open();
    type(byId<HTMLInputElement>("gig-search")!, "promo");
    expect(listedIds()).toEqual(["g2"]);
    // The client's name is searchable too, as on the tab.
    type(byId<HTMLInputElement>("gig-search")!, "acme");
    expect(listedIds()).toEqual(["g1"]);
  });

  it("writes the id and closes when a row is picked", () => {
    const onChange = vi.fn();
    render({ onChange });
    open();
    click(byId("p-row-g2"));
    expect(onChange).toHaveBeenCalledWith("g2");
    expect(byId("p-sheet")).toBeNull();
  });

  it("returns focus to the trigger after a pick", () => {
    render();
    act(() => trigger().focus());
    open();
    expect(document.activeElement).not.toBe(trigger());
    click(byId("p-row-g1"));
    expect(document.activeElement).toBe(trigger());
  });

  it("offers a none row that clears the value, worded as the placeholder", () => {
    const onChange = vi.fn();
    render({ value: "g1", onChange });
    open();
    expect(byId("p-none")?.textContent).toBe("Not linked");
    click(byId("p-none"));
    expect(onChange).toHaveBeenCalledWith("");
    expect(byId("p-sheet")).toBeNull();
  });

  it("offers no none row when allowNone is false", () => {
    render({ allowNone: false });
    open();
    expect(byId("p-none")).toBeNull();
    expect(listedIds()).toEqual(["g1", "g2"]);
  });

  it("starts every open with fresh filters", () => {
    render();
    open();
    type(byId<HTMLInputElement>("gig-search")!, "promo");
    expect(listedIds()).toEqual(["g2"]);
    click(byId("p-sheet-close"));
    open();
    expect(byId<HTMLInputElement>("gig-search")?.value).toBe("");
    expect(listedIds()).toEqual(["g1", "g2"]);
  });

  it("says when the filters hid everything, and clears them from there", () => {
    render();
    open();
    type(byId<HTMLInputElement>("gig-search")!, "nothing like this");
    expect(listedIds()).toEqual([]);
    expect(byId("p-sheet")?.textContent).toContain("No gigs match these filters");
    click(byId("p-clear"));
    expect(listedIds()).toEqual(["g1", "g2"]);
    expect(byId("p-sheet")?.textContent).not.toContain("No gigs match");
  });

  it("says when the caller offered nothing at all, without a filter bar", () => {
    render({ gigs: [] });
    open();
    const sheet = byId("p-sheet")!;
    expect(sheet.textContent).toContain("No gigs to choose from");
    expect(sheet.textContent).not.toContain("No gigs match");
    expect(sheet.querySelector('[data-testid="gig-filters"]')).toBeNull();
    // The none row is still a legitimate choice — "not linked" is an
    // answer even when there is nothing to link to.
    expect(byId("p-none")).not.toBeNull();
  });

  it("closes on Escape without changing the value", () => {
    const onChange = vi.fn();
    render({ value: "g1", onChange });
    open();
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(byId("p-sheet")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});
