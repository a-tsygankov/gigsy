/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { COMPLETED_FINAL_CLASSES, STATUS_PILL_CLASSES, StatusPill } from "./StatusPill.tsx";
import { GIG_STATUSES } from "../lib/types.ts";

// Same setup as HelpProvider.test.tsx: react-dom's `act` warns without
// this, because nothing here is React Testing Library.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function render(props: Parameters<typeof StatusPill>[0]): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<StatusPill {...props} />));
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("StatusPill", () => {
  it("renders every status as lowercase text", () => {
    for (const status of GIG_STATUSES) {
      const el = render({ status });
      expect(el.textContent).toBe(status);
    }
  });

  it("shows no paid badge by default", () => {
    const el = render({ status: "completed" });
    expect(el.querySelector("[data-testid='paid-badge']")).toBeNull();
  });

  it("shows paid as a badge of its own, alongside the status — not instead of it", () => {
    const el = render({ status: "completed", paid: true });
    const badge = el.querySelector("[data-testid='paid-badge']");
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe("paid");
    expect(el.textContent).toBe("completedpaid");
  });

  it("a lead paid in advance can say so too — paid is not gated on status", () => {
    // The whole point of the split: paid-ness is derived from the
    // money, independent of the lifecycle stage (lib/gig-pay.ts).
    const el = render({ status: "lead", paid: true });
    expect(el.querySelector("[data-testid='paid-badge']")).not.toBeNull();
  });

  it("draws a final completed green, and says so in data-final", () => {
    // A completed gig with nothing to hand over is finished; amber
    // would say "still something to do" (StatusPill.tsx).
    const el = render({ status: "completed", final: true });
    const pill = el.querySelector<HTMLElement>("[data-testid='status-pill']")!;
    expect(pill.dataset["final"]).toBe("true");
    expect(pill.className).toContain("emerald");
    expect(pill.className).not.toContain("amber");
    expect(COMPLETED_FINAL_CLASSES).toContain("emerald");
    expect(pill.textContent).toBe("completed");
  });

  it("keeps completed amber when it is not final", () => {
    const el = render({ status: "completed" });
    const pill = el.querySelector<HTMLElement>("[data-testid='status-pill']")!;
    expect(pill.dataset["final"]).toBeUndefined();
    expect(pill.className).toContain("amber");
  });

  it("leaves delivered teal even when told it is final", () => {
    // `final` is about completed only; delivered has its own hue and
    // must not be recoloured by a caller that passes the flag blindly.
    const el = render({ status: "delivered", final: true });
    const pill = el.querySelector<HTMLElement>("[data-testid='status-pill']")!;
    expect(pill.dataset["final"]).toBeUndefined();
    expect(pill.className).toContain("teal");
  });

  it("gives delivered its own hue, not one another status already uses", () => {
    // Extracted from the bg-* utility, not the whole class string: two
    // entries can share a hue and still produce distinct strings (e.g.
    // cancelled's trailing `line-through`), which a Set of full class
    // strings would not catch.
    const hues = Object.values(STATUS_PILL_CLASSES).map(
      (cls) => cls.match(/bg-(\w+)-\d+/)?.[1],
    );
    expect(new Set(hues).size).toBe(GIG_STATUSES.length);
    expect(STATUS_PILL_CLASSES.delivered).toContain("teal");
  });
});
