/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GigRow, gigSummary, type GigRowProps } from "./GigRow.tsx";
import type { Gig } from "../lib/types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function gig(over: Partial<Gig> = {}): Gig {
  return {
    id: "g1",
    clientId: "c1",
    parentGigId: null,
    batchId: null,
    title: "Tasting, Soho",
    status: "confirmed",
    location: "Costco on 5th",
    dateTime: new Date(2026, 8, 12, 14, 0).getTime(),
    durationMinutes: null,
    payType: "fixed",
    hourlyRateCents: null,
    workStartedAt: null,
    workEndedAt: null,
    breakMinutes: null,
    calendarEventId: null,
    amountOfferedCents: 15000,
    amountPaidCents: null,
    expectedCents: 15000,
    notes: null,
    source: null,
    createdAt: 0,
    modifiedAt: 0,
    ...over,
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function render(props: GigRowProps): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  // A MemoryRouter because the link mode renders a react-router <Link>.
  act(() =>
    root!.render(
      <MemoryRouter>
        <GigRow {...props} />
      </MemoryRouter>,
    ),
  );
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

describe("GigRow delivery", () => {
  const pill = (el: HTMLElement) =>
    el.querySelector<HTMLElement>('[data-testid="status-pill"]')!;

  it("draws completed as final when the work is not delivered", () => {
    const el = render({ gig: gig({ status: "completed" }), clientName: "Acme", to: "/gigs/g1", deliverable: false });
    expect(pill(el).dataset["final"]).toBe("true");
  });

  it("keeps completed amber (not final) on deliverable work", () => {
    const el = render({ gig: gig({ status: "completed" }), clientName: "Acme", to: "/gigs/g1", deliverable: true });
    expect(pill(el).dataset["final"]).toBeUndefined();
  });

  it("assumes deliverable when the caller has not said", () => {
    // The pre-delivery default: a caller that has not asked must not
    // declare every completed gig finished.
    const el = render({ gig: gig({ status: "completed" }), clientName: "Acme", to: "/gigs/g1" });
    expect(pill(el).dataset["final"]).toBeUndefined();
  });
});

describe("gigSummary", () => {
  it("heads with the display title and repeats the client only when it is not the heading", () => {
    expect(gigSummary(gig(), "Acme")).toEqual({
      heading: "Tasting, Soho",
      sub: ["Acme", "Sat, Sep 12, 2:00 PM", "Costco on 5th"].join(" · "),
    });
    // No title and no notes: the client IS the heading, so the sub-line
    // must not say it twice.
    expect(gigSummary(gig({ title: null }), "Acme")).toEqual({
      heading: "Acme",
      sub: ["Sat, Sep 12, 2:00 PM", "Costco on 5th"].join(" · "),
    });
  });

  it("says there is no date rather than leaving a gap, and drops a missing location", () => {
    expect(gigSummary(gig({ dateTime: null, location: null }), null).sub).toBe("No date yet");
  });
});

describe("GigRow as a link", () => {
  it("navigates to the gig and shows heading, sub-line, pill and money", () => {
    const el = render({ gig: gig(), clientName: "Acme", to: "/gigs/g1" });
    const link = el.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("/gigs/g1");
    expect(link.textContent).toContain("Tasting, Soho");
    expect(link.textContent).toContain("Acme · Sat, Sep 12, 2:00 PM · Costco on 5th");
    expect(link.querySelector('[data-testid="status-pill"]')?.textContent).toBe("confirmed");
    expect(link.textContent).toContain("$150.00");
    expect(el.querySelector("button")).toBeNull();
  });

  it("shows what was paid over what is expected, and no figure when there is neither", () => {
    expect(
      render({ gig: gig({ amountPaidCents: 5000 }), clientName: null, to: "/x" }).textContent,
    ).toContain("$50.00");
    expect(
      render({
        gig: gig({ amountOfferedCents: null, expectedCents: null }),
        clientName: null,
        to: "/x",
      }).textContent,
    ).not.toContain("$");
  });

  it("marks an unsynced gig with a labelled dot, and nothing otherwise", () => {
    expect(
      render({ gig: gig(), clientName: null, to: "/x", unsynced: true }).querySelector(
        '[data-testid="gig-unsynced"]',
      )?.getAttribute("aria-label"),
    ).toBe("Not synced yet");
    expect(
      render({ gig: gig(), clientName: null, to: "/x" }).querySelector(
        '[data-testid="gig-unsynced"]',
      ),
    ).toBeNull();
  });
});

describe("GigRow as a button", () => {
  it("is a real button carrying the test id, and reports the choice", () => {
    const onSelect = vi.fn();
    const el = render({ gig: gig(), clientName: "Acme", onSelect, testId: "pick-g1" });
    const button = el.querySelector<HTMLButtonElement>('[data-testid="pick-g1"]')!;
    expect(button.tagName).toBe("BUTTON");
    // Never a submit: the picker sits inside forms.
    expect(button.type).toBe("button");
    expect(button.textContent).toContain("Tasting, Soho");
    expect(el.querySelector("a")).toBeNull();
    act(() => button.click());
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("says whether it is the current choice through aria-pressed", () => {
    expect(
      render({ gig: gig(), clientName: null, onSelect: () => {}, selected: true })
        .querySelector("button")
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      render({ gig: gig(), clientName: null, onSelect: () => {} })
        .querySelector("button")
        ?.getAttribute("aria-pressed"),
    ).toBe("false");
  });
});
