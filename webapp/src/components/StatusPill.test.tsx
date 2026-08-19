/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { StatusPill } from "./StatusPill.tsx";
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
});
