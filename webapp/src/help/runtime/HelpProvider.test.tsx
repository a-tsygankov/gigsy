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

  it("clears a stale unavailable message once a new scenario starts", async () => {
    // The bug: `startScenario` only ever *sets* `unavailable` on its
    // failure paths — unlike `openHelp`, it never clears it on entry.
    // A user who fails a scenario, ignores both banner buttons, and
    // just picks something else (or retries the same one) would carry
    // the old message into an entirely successful run: the fixed
    // banner would sit on screen through the whole live tour, saying
    // something is unavailable while help is actively working.
    mount("/");
    vi.mocked(runTour).mockRejectedValueOnce(new Error("chunk 404"));

    await act(async () => {
      await latest!.startScenario("open-settings");
    });
    expect(latest!.unavailable).toBe("This help step is currently unavailable.");
    expect(container!.querySelector('[data-testid="help-unavailable"]')).not.toBeNull();

    const cancel = vi.fn();
    vi.mocked(runTour).mockResolvedValueOnce(cancel);

    await act(async () => {
      await latest!.startScenario("open-settings");
    });

    expect(latest!.unavailable).toBeNull();
    expect(container!.querySelector('[data-testid="help-unavailable"]')).toBeNull();
  });

  it("renders the unavailable message where the user actually is, even after the scenario navigated away first", async () => {
    // The bug this guards: HelpSection (the only thing that used to
    // show `unavailable`) mounts solely on "/settings", but a scenario
    // can fail after navigating elsewhere — "Open Settings" starts on
    // "/". A message that only a menu on "/settings" can show is
    // invisible to a user who is, at the moment of failure, on "/".
    // This mounts the real HelpProvider tree — nothing about the
    // banner is stubbed — and checks the actual DOM, not just the
    // context's own `unavailable` field, after exactly that sequence.
    mount("/settings");
    vi.mocked(runTour).mockRejectedValueOnce(new Error("chunk 404"));

    // Two-phase act for the same reason as "navigates to startRoute and
    // only then builds the tour" below: React 18 queues the navigate
    // triggered inside the callback and only flushes it once the
    // callback settles, so awaiting all of `startScenario` in one act
    // scope would deadlock on a navigation that cannot render until
    // this scope lets go.
    let pending: Promise<void>;
    await act(async () => {
      pending = latest!.startScenario("open-settings");
    });
    await act(async () => {
      await pending;
    });

    expect(pathname).toBe("/");
    expect(latest!.unavailable).toBe("This help step is currently unavailable.");
    const banner = container!.querySelector('[data-testid="help-unavailable"]');
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toContain("This help step is currently unavailable.");
  });

  it("Back to Help on the banner returns to /settings, reopens help, and clears the message", async () => {
    mount("/settings");
    vi.mocked(runTour).mockRejectedValueOnce(new Error("chunk 404"));

    let pending: Promise<void>;
    await act(async () => {
      pending = latest!.startScenario("open-settings");
    });
    await act(async () => {
      await pending;
    });
    expect(pathname).toBe("/");

    const back = container!.querySelector<HTMLButtonElement>(
      '[data-testid="help-unavailable-back"]',
    );
    expect(back).not.toBeNull();
    act(() => {
      back!.click();
    });

    expect(pathname).toBe("/settings");
    expect(latest!.unavailable).toBeNull();
    expect(latest!.isOpen).toBe(true);
    expect(container!.querySelector('[data-testid="help-unavailable"]')).toBeNull();
  });

  it("Close on the banner dismisses the message without navigating", async () => {
    mount("/");
    vi.mocked(runTour).mockRejectedValueOnce(new Error("chunk 404"));

    await act(async () => {
      await latest!.startScenario("open-settings");
    });

    const dismiss = container!.querySelector<HTMLButtonElement>(
      '[data-testid="help-unavailable-dismiss"]',
    );
    act(() => {
      dismiss!.click();
    });

    expect(pathname).toBe("/");
    expect(latest!.unavailable).toBeNull();
    expect(container!.querySelector('[data-testid="help-unavailable"]')).toBeNull();
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

  it("does not render the help sheet until openHelp is called", () => {
    mount("/");

    expect(container!.querySelector('[data-testid="help-sheet"]')).toBeNull();

    act(() => {
      latest!.openHelp();
    });

    expect(container!.querySelector('[data-testid="help-sheet"]')).not.toBeNull();
  });

  it("closes the help sheet on Escape", () => {
    mount("/");

    act(() => {
      latest!.openHelp();
    });
    expect(container!.querySelector('[data-testid="help-sheet"]')).not.toBeNull();

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });

    expect(latest!.isOpen).toBe(false);
    expect(container!.querySelector('[data-testid="help-sheet"]')).toBeNull();
  });

  it("picking a topic in the help sheet closes the sheet and starts the scenario", async () => {
    mount("/"); // open-settings' startRoute is "/", so no navigation wait is needed
    const cancel = vi.fn();
    vi.mocked(runTour).mockResolvedValueOnce(cancel);

    act(() => {
      latest!.openHelp();
    });
    const startButton = container!.querySelector<HTMLButtonElement>(
      '[data-testid="help-start-open-settings"]',
    );
    expect(startButton).not.toBeNull();

    await act(async () => {
      startButton!.click();
      await Promise.resolve();
    });

    expect(latest!.isOpen).toBe(false);
    expect(container!.querySelector('[data-testid="help-sheet"]')).toBeNull();
    expect(runTour).toHaveBeenCalledTimes(1);
  });

  it("does not cancel a tour when the user takes a hop the scenario declared", async () => {
    // record-work's whole shape: start on /gigs, the user taps their
    // own gig, the tour follows. Without this the route-change effect
    // kills the tour on the very hop it exists to make.
    const cancel = vi.fn();
    vi.mocked(runTour).mockResolvedValue(cancel);

    mount("/gigs"); // record-work's startRoute, so no navigation wait.
    await act(async () => {
      await latest!.startScenario("record-work");
    });
    expect(runTour).toHaveBeenCalledTimes(1);

    act(() => navigate!("/gigs/8f14e45f-ceea-467a-9a36-dedd4bea2543"));

    expect(cancel).not.toHaveBeenCalled();
  });

  it("still cancels a tour when the user goes somewhere the scenario never mentioned", async () => {
    const cancel = vi.fn();
    vi.mocked(runTour).mockResolvedValue(cancel);

    mount("/gigs");
    await act(async () => {
      await latest!.startScenario("record-work");
    });

    act(() => navigate!("/settings"));

    expect(cancel).toHaveBeenCalled();
  });
});
