/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { WorkCard } from "./WorkCard.tsx";
import { msToLocalInput } from "../../lib/datetime.ts";
import type { Gig, GigInput } from "../../lib/types.ts";

// Same setup as DateTimeField.test.tsx: react-dom's `act` warns without
// this, because nothing here is React Testing Library.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => {
  // DateTimeField's popover positions itself with floating-ui, which
  // observes the trigger. jsdom has no ResizeObserver, and without one
  // the component throws on mount rather than failing an assertion.
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
});

const GIG: Gig = {
  id: "g1",
  clientId: null,
  title: null,
  status: "confirmed",
  location: null,
  dateTime: null,
  durationMinutes: 240,
  payType: "hourly",
  hourlyRateCents: 5000,
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

function render(
  gig: Partial<Gig>,
  props: Partial<{ saving: boolean; failed: boolean; savedAt: number | null }> = {},
): {
  el: HTMLDivElement;
  onCommit: ReturnType<typeof vi.fn>;
  onFlush: ReturnType<typeof vi.fn>;
} {
  const onCommit = vi.fn();
  const onFlush = vi.fn();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <WorkCard
        gig={{ ...GIG, ...gig }}
        onCommit={onCommit as (patch: GigInput) => void}
        onFlush={onFlush as (patch: GigInput) => void}
        saving={props.saving ?? false}
        failed={props.failed ?? false}
        savedAt={props.savedAt ?? null}
      />,
    ),
  );
  return { el: container, onCommit, onFlush };
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
});

const find = <T extends Element>(testId: string): T =>
  container!.querySelector<T>(`[data-testid='${testId}']`)!;

/** React tracks controlled fields off the native event, not "change" on
 *  an input — the same reason DateTimeField.test.tsx writes through the
 *  prototype setter. */
function setValue(el: HTMLInputElement | HTMLSelectElement, value: string): void {
  const proto =
    el instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  act(() => {
    // A <select> reports through "change"; a text box through "input".
    el.dispatchEvent(
      new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
    );
  });
}

/** React 17+ listens for the bubbling "focusout", not "blur". */
function blur(el: HTMLElement): void {
  act(() => {
    el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
}

describe("WorkCard", () => {
  it("saves the status the moment it changes — no button to press", () => {
    const { el, onCommit } = render({});
    expect(el.querySelector("[data-testid='gig-save']")).toBeNull();
    setValue(find<HTMLSelectElement>("gig-status"), "completed");
    expect(onCommit).toHaveBeenCalledWith({ status: "completed" });
  });

  it("stamps Start to the current minute, seconds discarded", () => {
    vi.useFakeTimers();
    // 14:07:36 local — the seconds are what must not survive.
    vi.setSystemTime(new Date(2027, 2, 4, 14, 7, 36));
    const { onCommit } = render({});
    act(() => find<HTMLButtonElement>("work-start").click());
    const patch = onCommit.mock.calls[0]![0] as GigInput;
    expect(msToLocalInput(patch.workStartedAt ?? null)).toBe("2027-03-04T14:07");
    expect((patch.workStartedAt ?? 0) % 60_000).toBe(0);
  });

  it("will not restamp a start that already exists", () => {
    const { onCommit } = render({ workStartedAt: Date.now() });
    const start = find<HTMLButtonElement>("work-start");
    expect(start.disabled).toBe(true);
    act(() => start.click());
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("cannot stop a shift that never started", () => {
    render({});
    expect(find<HTMLButtonElement>("work-stop").disabled).toBe(true);
  });

  it("stops an open shift and prices it", () => {
    vi.useFakeTimers();
    const started = new Date(2027, 2, 4, 9, 0).getTime();
    vi.setSystemTime(new Date(2027, 2, 4, 12, 18));
    const { onCommit } = render({ workStartedAt: started });
    act(() => find<HTMLButtonElement>("work-stop").click());
    const patch = onCommit.mock.calls[0]![0] as GigInput;
    expect(msToLocalInput(patch.workEndedAt ?? null)).toBe("2027-03-04T12:18");
    // 198 minutes at $50/h, straight off the draft — no round trip.
    expect(find("gig-expected-pay").textContent).toContain("$165.00");
  });

  it("prices from the plan until the shift is finished", () => {
    // 240 booked minutes at $50/h. A started-but-not-stopped shift is
    // not a length yet (lib/gig-pay.ts), so the quote still stands.
    render({ workStartedAt: Date.now() });
    expect(find("gig-expected-pay").textContent).toBe("Expected $200.00");
  });

  it("subtracts a break, but only once it stops moving", () => {
    const started = new Date(2027, 2, 4, 9, 0).getTime();
    const { onCommit } = render({
      workStartedAt: started,
      workEndedAt: started + 198 * 60_000,
    });
    const box = find<HTMLInputElement>("gig-break");
    setValue(box, "18");
    // Typed but not committed: the figure moves, the record does not.
    expect(find("gig-expected-pay").textContent).toContain("$150.00");
    expect(onCommit).not.toHaveBeenCalled();
    blur(box);
    expect(onCommit).toHaveBeenCalledWith({
      workStartedAt: started,
      workEndedAt: started + 198 * 60_000,
      breakMinutes: 18,
    });
  });

  it("refuses a break that fills the whole shift, and saves nothing", () => {
    const started = new Date(2027, 2, 4, 9, 0).getTime();
    const { onCommit } = render({
      workStartedAt: started,
      workEndedAt: started + 3_600_000,
    });
    const box = find<HTMLInputElement>("gig-break");
    setValue(box, "600");
    blur(box);
    expect(find("work-error").textContent).toBe("The break can't fill the whole shift.");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("offers the hourly override, showing what it replaces", () => {
    const { onCommit } = render({});
    expect(find("gig-computed-pay").textContent).toContain("Computed $200.00");
    const box = find<HTMLInputElement>("gig-override");
    setValue(box, "189.17");
    blur(box);
    expect(onCommit).toHaveBeenCalledWith({ amountOfferedCents: 18917 });
    expect(find("gig-expected-pay").textContent).toContain("$189.17");
    expect(find("gig-computed-pay").textContent).toContain("Computed $200.00 · overridden");
  });

  it("clears the override back to the computed figure", () => {
    const { onCommit } = render({ amountOfferedCents: 18917 });
    expect(find("gig-expected-pay").textContent).toContain("$189.17");
    act(() => find<HTMLButtonElement>("gig-override-clear").click());
    expect(onCommit).toHaveBeenCalledWith({ amountOfferedCents: null });
    expect(find("gig-expected-pay").textContent).toContain("$200.00");
  });

  it("refuses an override that is not money, and one that is zero", () => {
    const { onCommit } = render({});
    const box = find<HTMLInputElement>("gig-override");
    setValue(box, "lots");
    blur(box);
    expect(find("work-error").textContent).toContain("isn't a valid dollar value");
    setValue(box, "0");
    blur(box);
    // assertPositive would throw on this in the data service, so it
    // never reaches one.
    expect(find("work-error").textContent).toContain("greater than zero");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("has no override on a fixed gig — there the same field is the fee", () => {
    const { el } = render({ payType: "fixed", amountOfferedCents: 15000 });
    expect(el.querySelector("[data-testid='gig-override']")).toBeNull();
    expect(find("gig-expected-pay").textContent).toBe("Expected $150.00");
  });

  it("says it saves as you go rather than pretending there is a button", () => {
    const { el } = render({});
    expect(find("work-save-state").textContent).toContain("nothing to press");
    expect(el.querySelector("button[data-testid='gig-save']")).toBeNull();
  });

  it("tells a successful save apart from never having written", () => {
    // One idle string for both states is what this replaces: it could
    // not answer the only question the line exists to answer.
    render({}, { savedAt: new Date(2027, 2, 4, 14, 7).getTime() });
    const line = find("work-save-state").textContent ?? "";
    expect(line).toContain("Saved at");
    expect(line).not.toContain("nothing to press");
  });

  it("says so while a typed value is still uncommitted", () => {
    const { onCommit } = render({});
    expect(find("work-save-state").textContent).toContain("nothing to press");
    const box = find<HTMLInputElement>("gig-break");
    setValue(box, "18");
    // Dirty is measured against the RECORD, not against a flag — which
    // is why it survives the blur here and clears below: the parent has
    // to come back with the saved gig before anything is settled.
    expect(find("work-save-state").textContent).toContain("Not saved yet");
    blur(box);
    expect(onCommit).toHaveBeenCalled();
    expect(find("work-save-state").textContent).toContain("Not saved yet");

    const savedAt = new Date(2027, 2, 4, 14, 7).getTime();
    act(() =>
      root!.render(
        <WorkCard
          gig={{ ...GIG, breakMinutes: 18 }}
          onCommit={onCommit as (patch: GigInput) => void}
          onFlush={() => {}}
          saving={false}
          failed={false}
          savedAt={savedAt}
        />,
      ),
    );
    const line = find("work-save-state").textContent ?? "";
    expect(line).not.toContain("Not saved yet");
    expect(line).toContain("Saved at");
  });

  it("flushes a typed break on unmount, when no blur ever came", () => {
    // The route change: tapping the tab bar with a break in the box.
    // `focusout` is not guaranteed for an input unmounted underneath
    // the focus, and on iOS Safari tapping a link moves no focus at
    // all — so without this the value is silently discarded while the
    // card still claims it saves as you go.
    const { onFlush } = render({});
    setValue(find<HTMLInputElement>("gig-break"), "18");
    expect(onFlush).not.toHaveBeenCalled();
    act(() => root!.unmount());
    root = null;
    expect(onFlush).toHaveBeenCalledWith({
      workStartedAt: null,
      workEndedAt: null,
      breakMinutes: 18,
    });
  });

  it("flushes on pagehide, which is the one iOS Safari fires", () => {
    const { onFlush } = render({});
    setValue(find<HTMLInputElement>("gig-override"), "189.17");
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(onFlush).toHaveBeenCalledWith({ amountOfferedCents: 18917 });
  });

  it("flushes nothing when nothing was typed", () => {
    // The delete button unmounts this card too. A flush with no pending
    // change is what stops a stale draft resurrecting a deleted gig.
    const { onFlush } = render({ workStartedAt: 1_800_000_000_000 });
    act(() => root!.unmount());
    root = null;
    expect(onFlush).not.toHaveBeenCalled();
  });

  it("flushes nothing while the typed value is invalid", () => {
    const { onFlush } = render({});
    setValue(find<HTMLInputElement>("gig-override"), "lots");
    act(() => root!.unmount());
    root = null;
    expect(onFlush).not.toHaveBeenCalled();
  });

  it("refuses a fractional break, which the schema would 400", () => {
    // The rule lives in lib/work-log.ts; this is that it is wired in.
    const { onCommit } = render({});
    const box = find<HTMLInputElement>("gig-break");
    setValue(box, "18.5");
    blur(box);
    expect(find("work-error").textContent).toBe("Breaks are counted in whole minutes.");
    expect(onCommit).not.toHaveBeenCalled();
  });
});
