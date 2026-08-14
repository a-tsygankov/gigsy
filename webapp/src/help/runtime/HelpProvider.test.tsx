/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
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

let container: HTMLDivElement | null;
let root: Root | null;
let latest: ReturnType<typeof useHelp> | null;
let pathname: string | null;
let navigate: ReturnType<typeof useNavigate> | null;

function Harness() {
  latest = useHelp();
  pathname = useLocation().pathname;
  navigate = useNavigate();
  return null;
}

function mount(initialPath = "/"): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <MemoryRouter initialEntries={[initialPath]}>
        <HelpProvider>
          <Harness />
        </HelpProvider>
      </MemoryRouter>,
    );
  });
}

/** Unmounts early, so a test can assert what teardown does and the
 *  `afterEach` below still stays a no-op double-unmount. */
function unmount(): void {
  if (root === null) return;
  const current = root;
  root = null;
  act(() => current.unmount());
}

beforeEach(() => {
  latest = null;
  pathname = null;
  navigate = null;
  container = null;
  root = null;
  vi.mocked(runTour).mockReset();
});

afterEach(() => {
  // Guarded: a test that throws before `mount` returns would otherwise
  // have its real failure replaced by a TypeError from this hook, which
  // is exactly the kind of masking this suite exists to prevent.
  unmount();
  container?.remove();
  container = null;
  // One test moves the DOM location to prove it is not what the route
  // wait reads; jsdom shares it across the file.
  window.history.pushState({}, "", "/");
});

describe("HelpProvider", () => {
  it("reports a scenario id that does not exist in the registry", async () => {
    mount("/");

    await act(async () => {
      await latest!.startScenario("no-such-scenario");
    });

    expect(latest!.unavailable).toBe("That help topic no longer exists.");
    expect(latest!.isOpen).toBe(true);
    expect(runTour).not.toHaveBeenCalled();
  });

  it("surfaces the required failure message when the tour runtime fails to start", async () => {
    mount("/"); // open-settings' startRoute is "/", so no navigation wait is needed
    vi.mocked(runTour).mockRejectedValueOnce(new Error("chunk 404"));

    await act(async () => {
      await latest!.startScenario("open-settings");
    });

    expect(latest!.unavailable).toBe("This help step is currently unavailable.");
    // Spec §10: the message needs somewhere to be shown, with a way
    // back to the menu — see the next test for why this assertion is
    // the whole point, not a bonus check.
    expect(latest!.isOpen).toBe(true);
  });

  it("reopens the menu so a failed scenario's message is actually visible", async () => {
    // The bug this guards: `startScenario` closes the menu (setIsOpen
    // false) before it can possibly fail, and nothing used to reopen
    // it — so `unavailable` could end up set while `isOpen` stayed
    // false, which is exactly the state a menu gated on `isOpen` would
    // never render. A menu that was already open makes that failure
    // mode visible: if the fix ever regresses, this is the test that
    // would watch the menu silently close on a failure instead of
    // staying open around the message.
    mount("/");
    vi.mocked(runTour).mockRejectedValueOnce(new Error("chunk 404"));

    act(() => {
      latest!.openHelp();
    });
    expect(latest!.isOpen).toBe(true);
    expect(latest!.unavailable).toBeNull();

    await act(async () => {
      await latest!.startScenario("open-settings");
    });

    expect(latest!.isOpen).toBe(true);
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

  it("navigates to startRoute and only then builds the tour", async () => {
    // The DOM location goes somewhere the router will never be, so that
    // "the router settled on /" and "window.location says /" cannot be
    // true at once. Without it the test is vacuous: jsdom starts at "/",
    // which is also open-settings' startRoute, so a `waitForRoute`
    // reading `window.location` would pass by accident. The two really
    // do diverge in production the moment a `basename` exists; this is
    // what lets the test see it.
    window.history.pushState({}, "", "/not-the-router");
    // Mounted away from "/", so the scenario's startRoute forces the
    // navigate-and-wait path this test exists for.
    mount("/settings");
    const cancel = vi.fn();
    vi.mocked(runTour).mockResolvedValueOnce(cancel);

    // Deliberately started but NOT awaited inside this act scope. React
    // 18 queues work triggered inside an act callback and only flushes
    // it when that callback settles, so awaiting the whole of
    // `startScenario` here would block on a navigation that cannot
    // render until we let go — a deadlock in the test, not in the code.
    // Letting the scope close flushes the navigate; the second scope
    // then lets the route wait observe it and the tour get built.
    let pending: Promise<void>;
    await act(async () => {
      pending = latest!.startScenario("open-settings");
    });
    await act(async () => {
      await pending;
    });

    // The wait reads the ROUTER's location. MemoryRouter never writes
    // `window.location`, so a version of `waitForRoute` reading the DOM
    // would time out here for reasons that have nothing to do with the
    // code under test — and then report the wrong failure.
    expect(pathname).toBe("/");
    expect(runTour).toHaveBeenCalledTimes(1);
    expect(latest!.unavailable).toBeNull();
    // The navigation the provider performed itself must not read as
    // "the user left mid-tour".
    expect(cancel).not.toHaveBeenCalled();
  });

  it("cancels a running tour when the route changes out from under it", async () => {
    mount("/");
    const cancel = vi.fn();
    vi.mocked(runTour).mockResolvedValueOnce(cancel);

    await act(async () => {
      await latest!.startScenario("open-settings");
    });
    expect(cancel).not.toHaveBeenCalled();

    // The user navigates away — a tour left running here would be
    // spotlighting detached nodes. Driven through the router itself,
    // not by re-rendering with different `initialEntries`, which
    // MemoryRouter reads once and ignores thereafter.
    await act(async () => {
      navigate!("/expenses");
    });

    expect(pathname).toBe("/expenses");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("cancels a running tour on unmount", async () => {
    mount("/");
    const cancel = vi.fn();
    vi.mocked(runTour).mockResolvedValueOnce(cancel);

    await act(async () => {
      await latest!.startScenario("open-settings");
    });
    expect(cancel).not.toHaveBeenCalled();

    unmount();

    // Driver.js appends its overlay to <body>, not to the React tree, so
    // nothing about unmounting removes it on React's own account.
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("does not surface a late unavailable report from an abandoned attempt", async () => {
    mount("/");
    let report: ((reason: string) => void) | undefined;
    vi.mocked(runTour).mockImplementationOnce(async (_scenario, options) => {
      report = options.onUnavailable;
      return vi.fn();
    });

    await act(async () => {
      await latest!.startScenario("open-settings");
    });

    act(() => {
      latest!.closeHelp();
    });

    // A missing target can be reported seconds after the step began
    // waiting — long after the user gave up on it.
    act(() => {
      report!("target settings-link not found");
    });

    expect(latest!.unavailable).toBeNull();
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
