/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { JobCard } from "./JobCard.tsx";
import type { Gig } from "../../lib/types.ts";

// Same setup as DateTimeField.test.tsx: react-dom's `act` warns without
// this, because nothing here is React Testing Library.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const GIG: Gig = {
  id: "g1",
  clientId: null,
  parentGigId: null,
  title: null,
  status: "confirmed",
  location: null,
  dateTime: null,
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
  source: "manual",
  createdAt: 1,
  modifiedAt: 1,
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function render(gig: Partial<Gig>, clientName: string | null = null): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <MemoryRouter>
        <JobCard gig={{ ...GIG, ...gig }} clientName={clientName} />
      </MemoryRouter>,
    ),
  );
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

const row = (testId: string): HTMLElement | null =>
  container!.querySelector<HTMLElement>(`[data-testid='${testId}']`);

describe("JobCard", () => {
  it("links to the edit form for this gig", () => {
    render({});
    expect(row("gig-edit")?.getAttribute("href")).toBe("/gigs/g1/edit");
  });

  it("omits the rows that have nothing to say", () => {
    render({});
    expect(row("job-client")).toBeNull();
    expect(row("job-title")).toBeNull();
    expect(row("job-location")).toBeNull();
    expect(row("job-notes")).toBeNull();
  });

  it("shows them once they have something to say", () => {
    render(
      { title: "Costco tasting", location: "Booth 12", notes: "Park round the back" },
      "Acme Promotions",
    );
    expect(row("job-client")?.textContent).toBe("Acme Promotions");
    expect(row("job-title")?.textContent).toBe("Costco tasting");
    expect(row("job-location")?.textContent).toBe("Booth 12");
    expect(row("job-notes")?.textContent).toContain("Park round the back");
  });

  it("always states when, because a gig with no date blocks no time", () => {
    render({});
    expect(row("job-when")?.textContent).toBe("No date yet");
    expect(row("job-when")?.dataset["value"]).toBe("");
  });

  it("states the planned length beside the moment, in canonical form too", () => {
    // Local time on purpose: the row is what a person reads, and
    // `data-value` is the machine copy tests assert against.
    const when = new Date(2027, 2, 4, 9, 0).getTime();
    render({ dateTime: when, durationMinutes: 200 });
    expect(row("job-when")?.textContent).toContain("3h 20m");
    expect(row("job-when")?.dataset["value"]).toBe("2027-03-04T09:00");
  });

  it("always states how it pays, including when it is not set", () => {
    render({ payType: "fixed", amountOfferedCents: null });
    expect(row("job-pay")?.textContent).toBe("Fixed fee — not set");
  });

  it("states a fixed fee as a fee and an hourly gig as a rate", () => {
    render({ payType: "fixed", amountOfferedCents: 15000 });
    expect(row("job-pay")?.textContent).toBe("$150.00 fixed fee");
    act(() => root!.unmount());
    container!.remove();

    render({ payType: "hourly", hourlyRateCents: 5000 });
    expect(row("job-pay")?.textContent).toBe("$50.00 / hour");
  });

  it("never shows the work log — that is the work card's half", () => {
    const el = render({
      workStartedAt: Date.now(),
      workEndedAt: Date.now() + 3_600_000,
      breakMinutes: 18,
    });
    expect(el.textContent).not.toContain("Started");
    expect(el.textContent).not.toContain("break");
  });
});
