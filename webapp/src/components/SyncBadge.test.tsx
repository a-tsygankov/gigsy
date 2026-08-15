/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SyncBadge } from "./SyncBadge.tsx";

// Same setup as HelpProvider.test.tsx: react-dom's `act` warns without
// this, because nothing here is React Testing Library.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function render(props: Parameters<typeof SyncBadge>[0]): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<SyncBadge {...props} />));
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("SyncBadge", () => {
  it("renders nothing when online and fully synced", () => {
    expect(render({ online: true, pendingCount: 0 }).innerHTML).toBe("");
  });

  it("shows the offline chip regardless of anything else", () => {
    const el = render({ online: false, pendingCount: 3, stalled: true });
    expect(el.querySelector("[data-testid='sync-offline']")).not.toBeNull();
    expect(el.querySelector("[data-testid='sync-error']")).toBeNull();
  });

  it("shows the pending count when there is work queued", () => {
    const el = render({ online: true, pendingCount: 2 });
    expect(el.querySelector("[data-testid='sync-pending']")?.textContent).toBe("2↑");
  });

  /**
   * The regression this guards is a silent one: before the engine grew
   * a retry, a failed first pull left the app showing "No gigs yet" to
   * an account with hundreds, and nothing on screen said otherwise.
   */
  it("outranks the pending count when the engine has stalled", () => {
    const el = render({ online: true, pendingCount: 2, stalled: true });
    expect(el.querySelector("[data-testid='sync-error']")).not.toBeNull();
    expect(el.querySelector("[data-testid='sync-pending']")).toBeNull();
  });

  it("asks for another attempt when tapped", () => {
    const onRetry = vi.fn();
    const el = render({ online: true, pendingCount: 0, stalled: true, onRetry });

    act(() => {
      el.querySelector<HTMLButtonElement>("[data-testid='sync-error']")!.click();
    });

    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
