/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HelpProvider, useHelp } from "./HelpProvider.tsx";
import { runTour } from "./TourRenderer.ts";

// Auto-mocked: every export becomes a `vi.fn()` stub with the real
// signature, so `vi.mocked(runTour)` is fully typed with no casting —
// this is what "mocked TourRenderer" means for these tests. HelpProvider
// never reaches Driver.js itself.
vi.mock("./TourRenderer.ts");

// react-dom's own `act` warns without this, because nothing here is
// React Testing Library, which normally sets it. Not a project-wide
// setup file: this is the only test in the repo that mounts React.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let latest: ReturnType<typeof useHelp> | null;

function Harness() {
  latest = useHelp();
  return null;
}

function mount(initialPath = "/"): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter initialEntries={[initialPath]}>
        <HelpProvider>
          <Harness />
        </HelpProvider>
      </MemoryRouter>,
    );
  });
}

beforeEach(() => {
  latest = null;
  vi.mocked(runTour).mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("HelpProvider", () => {
  it("reports a scenario id that does not exist in the registry", async () => {
    mount("/");

    await act(async () => {
      await latest!.startScenario("no-such-scenario");
    });

    expect(latest!.unavailable).toBe("That help topic no longer exists.");
    expect(runTour).not.toHaveBeenCalled();
  });

  it("surfaces the required failure message when the tour runtime fails to start", async () => {
    mount("/"); // open-settings' startRoute is "/", so no navigation wait is needed
    vi.mocked(runTour).mockRejectedValueOnce(new Error("chunk 404"));

    await act(async () => {
      await latest!.startScenario("open-settings");
    });

    expect(latest!.unavailable).toBe("This help step is currently unavailable.");
  });

  it("cancels the first tour instead of stacking a second overlay when a scenario is started twice", async () => {
    mount("/");
    const cancel1 = vi.fn();
    const cancel2 = vi.fn();
    vi.mocked(runTour).mockResolvedValueOnce(cancel1).mockResolvedValueOnce(cancel2);

    await act(async () => {
      await latest!.startScenario("open-settings");
    });
    expect(cancel1).not.toHaveBeenCalled();

    await act(async () => {
      await latest!.startScenario("open-settings");
    });

    expect(cancel1).toHaveBeenCalledTimes(1);
    expect(cancel2).not.toHaveBeenCalled();
  });

  it("cancels a running tour when closeHelp is called", async () => {
    mount("/");
    const cancel = vi.fn();
    vi.mocked(runTour).mockResolvedValueOnce(cancel);

    await act(async () => {
      await latest!.startScenario("open-settings");
    });
    expect(cancel).not.toHaveBeenCalled();

    act(() => {
      latest!.closeHelp();
    });

    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("opens and closes the menu independently of any running tour", () => {
    mount("/");

    act(() => {
      latest!.openHelp();
    });
    expect(latest!.isOpen).toBe(true);

    act(() => {
      latest!.closeHelp();
    });
    expect(latest!.isOpen).toBe(false);
  });
});
