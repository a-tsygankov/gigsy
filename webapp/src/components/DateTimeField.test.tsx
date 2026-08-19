/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DateTimeField, type DateTimeFieldProps } from "./DateTimeField.tsx";
import { dateToLocalDate } from "../lib/datetime.ts";

// Same setup as HelpProvider.test.tsx: react-dom's `act` warns without
// this, because nothing here is React Testing Library.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => {
  // Radix's popover positions itself with floating-ui, which observes
  // the trigger. jsdom has no ResizeObserver, and without one the
  // popover throws on open rather than failing an assertion — so the
  // stub exists to let the component mount at all, not to measure
  // anything. Layout is not what these tests are about.
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function render(props: DateTimeFieldProps): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<DateTimeField {...props} />));
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function trigger(): HTMLButtonElement {
  return container!.querySelector<HTMLButtonElement>("[data-testid='f']")!;
}

/** The popover is portalled to <body>, so nothing inside it is reachable
 *  through the render container. */
function inPopover<T extends Element>(testId: string): T | null {
  return document.querySelector<T>(`[data-testid='${testId}']`);
}

/**
 * Open the popover AND wait for the calendar to arrive.
 *
 * The calendar is a dynamic import (DateTimeCalendar.tsx), so opening no
 * longer puts it in the DOM in the same tick. An async `act` flushes the
 * import and the render it causes; the loop is because resolving the
 * module and committing its output are separate turns of the microtask
 * queue, not one.
 */
async function open(): Promise<void> {
  // Load the module for real first. `act` only flushes microtasks, and
  // the dynamic import is a file read — without this the calendar never
  // arrives inside the loop below however many turns it is given.
  await import("./DateTimeCalendar.tsx");
  await act(async () => {
    trigger().click();
  });
  for (let turn = 0; turn < 10 && inPopover("f-calendar") === null; turn++) {
    await act(async () => {});
  }
}

/**
 * React tracks controlled inputs off the native "input" event, not
 * "change" — dispatching "change" alone leaves onChange unfired in a
 * plain jsdom render with no React Testing Library in front of it.
 */
function setValue(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(el, value);
  act(() => {
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("DateTimeField", () => {
  it("states the moment on the trigger, unopened", () => {
    render({ testId: "f", value: "2026-09-12T14:18", onChange: () => {} });
    // The visible text is localised, so the assertion is on the
    // canonical copy the trigger carries beside it.
    expect(trigger().dataset["value"]).toBe("2026-09-12T14:18");
    expect(trigger().textContent).toContain("Sep 12");
  });

  it("says there is no date rather than showing an empty box", () => {
    render({ testId: "f", value: "", onChange: () => {} });
    expect(trigger().textContent).toContain("No date yet");
    expect(trigger().dataset["value"]).toBe("");
  });

  it("keeps the calendar and the time input behind the trigger until it is opened", async () => {
    render({ testId: "f", value: "2026-09-12T14:18", onChange: () => {} });
    expect(inPopover("f-time")).toBeNull();
    expect(inPopover("f-calendar")).toBeNull();
    await open();
    expect(inPopover("f-time")).not.toBeNull();
    expect(inPopover("f-calendar")).not.toBeNull();
  });

  it("renders a time input, not a select", async () => {
    render({ testId: "f", value: "2026-09-12T14:18", onChange: () => {} });
    await open();
    const time = inPopover<HTMLInputElement>("f-time")!;
    expect(time.tagName).toBe("INPUT");
    expect(time.type).toBe("time");
    expect(time.value).toBe("14:18");
    // No step: the quarter-hour grid is gone and every minute is
    // enterable. `step` unset is what a native time input needs for
    // that, so its absence is the assertion.
    expect(time.getAttribute("step")).toBeNull();
  });

  it("emits the joined value when the time changes to an off-quarter minute", async () => {
    const onChange = vi.fn();
    render({ testId: "f", value: "2026-09-12T09:00", onChange });
    await open();
    setValue(inPopover<HTMLInputElement>("f-time")!, "14:07");
    expect(onChange).toHaveBeenCalledWith("2026-09-12T14:07");
  });

  it("marks the stored day as selected in the calendar", async () => {
    render({ testId: "f", value: "2026-09-12T14:18", onChange: () => {} });
    await open();
    // The cell carries react-day-picker's selection state; the button
    // inside it carries the day this app tags it with.
    const cell = inPopover<HTMLElement>("f-calendar")!
      .querySelector("[data-day-iso='2026-09-12']")!
      .closest("td");
    expect(cell?.getAttribute("data-selected")).toBe("true");
  });

  it("fills 09:00 when a day is picked before a time", async () => {
    const onChange = vi.fn();
    render({ testId: "f", value: "", onChange });
    await open();
    // Empty value means the calendar opens on today's month, so the day
    // clicked has to be one of today's month's own days.
    const someDay = new Date();
    someDay.setDate(15);
    const iso = dateToLocalDate(someDay);
    act(() => {
      inPopover<HTMLElement>("f-calendar")!
        .querySelector<HTMLButtonElement>(`[data-day-iso='${iso}']`)!
        .click();
    });
    expect(onChange).toHaveBeenCalledWith(`${iso}T09:00`);
  });

  it("keeps the time already set when a different day is picked", async () => {
    const onChange = vi.fn();
    render({ testId: "f", value: "2026-09-12T14:18", onChange });
    await open();
    act(() => {
      inPopover<HTMLElement>("f-calendar")!
        .querySelector<HTMLButtonElement>("[data-day-iso='2026-09-15']")!
        .click();
    });
    expect(onChange).toHaveBeenCalledWith("2026-09-15T14:18");
  });

  it("clears the whole value, never just the time", async () => {
    const onChange = vi.fn();
    render({ testId: "f", value: "2026-09-12T14:18", onChange });
    await open();
    act(() => inPopover<HTMLButtonElement>("f-clear")!.click());
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("disables the time until there is a day to attach it to", async () => {
    render({ testId: "f", value: "", onChange: () => {} });
    await open();
    expect(inPopover<HTMLInputElement>("f-time")!.disabled).toBe(true);
  });

  it("closes on Done, leaving the value alone", async () => {
    const onChange = vi.fn();
    render({ testId: "f", value: "2026-09-12T14:18", onChange });
    await open();
    act(() => inPopover<HTMLButtonElement>("f-done")!.click());
    expect(inPopover("f-time")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("puts BOTH the field's name and its value in the trigger's accessible name", () => {
    render({ testId: "f", value: "2026-09-12T09:00", label: "Started", onChange: () => {} });
    // The name has to be explicit. `Field` wraps this in a <label>, and
    // a wrapping label outranks an element's own contents in the
    // accessible-name algorithm — so neither the visible text nor an
    // sr-only span inside the button can get the moment into the name;
    // both lose to "Started" on its own. Checked against Chromium's
    // real computation, which reads "Started, Sat, Sep 12, 9:00 AM".
    const name = trigger().getAttribute("aria-label") ?? "";
    expect(name).toContain("Started");
    expect(name).toContain("Sep 12");
    // And the visible text is a subset of it, so voice control can act
    // on what a person can actually read (WCAG 2.5.3).
    expect(name).toContain(trigger().querySelector("span")?.textContent ?? " ");
  });

  it("still announces a value when no label was given", () => {
    render({ testId: "f", value: "", onChange: () => {} });
    expect(trigger().getAttribute("aria-label")).toBe("No date yet");
  });

  it("keeps the day when the time box is emptied", async () => {
    const onChange = vi.fn();
    render({ testId: "f", value: "2026-09-12T14:18", onChange });
    await open();
    setValue(inPopover<HTMLInputElement>("f-time")!, "");
    // Not "2026-09-12T", which reads back as no moment at all: the
    // trigger would say "No date yet" over a calendar still showing the
    // 12th highlighted, and saving would drop the day without a word.
    expect(onChange).toHaveBeenCalledWith("2026-09-12T09:00");
    expect(onChange).not.toHaveBeenCalledWith("2026-09-12T");
  });

  it("tags nothing when no testId is given", () => {
    const el = render({ value: "", onChange: () => {} });
    expect(el.querySelector("[data-testid]")).toBeNull();
  });
});
