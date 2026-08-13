/**
 * Owns "which scenario is running". Routing to a scenario's startRoute
 * happens here rather than in the renderer, because the tour has to be
 * built against the DOM it will highlight — starting a tour and then
 * navigating would spotlight elements that are about to unmount.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { appLog } from "../../lib/logger.ts";
import { getHelpScenario } from "../registry.ts";
import type { HelpScenarioId } from "../types.ts";

interface HelpContextValue {
  isOpen: boolean;
  openHelp(): void;
  closeHelp(): void;
  startScenario(id: HelpScenarioId): Promise<void>;
  /** Set when a scenario ended early — a missing target, or no branch
   *  matching. Rendered by the menu; never thrown into the app. */
  unavailable: string | null;
  dismissUnavailable(): void;
}

const HelpContext = createContext<HelpContextValue | null>(null);

export function useHelp(): HelpContextValue {
  const value = useContext(HelpContext);
  if (value === null) throw new Error("useHelp outside HelpProvider");
  return value;
}

const UNAVAILABLE_MESSAGE = "This help step is currently unavailable.";

/** Waits for the router to settle on `route` before the tour is built.
 *  Polling beats a timeout: it finishes as soon as it is true. A plain
 *  timer, not requestAnimationFrame — rAF never fires in a backgrounded
 *  tab, which would turn a bounded wait into an indefinite stall. */
async function waitForRoute(
  route: string,
  signal: AbortSignal,
  timeoutMs = 5_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !signal.aborted) {
    if (window.location.pathname === route) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return window.location.pathname === route;
}

export function HelpProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const navigate = useNavigate();
  const location = useLocation();

  // The live tour's own teardown (Driver.js destroy + its listener
  // cleanup), set once `runTour` actually returns one.
  const cancelRef = useRef<(() => void) | null>(null);
  // Aborts whatever `startScenario` attempt is currently in flight — the
  // route wait, the dynamic import, or the branch resolution inside
  // `runTour` — so giving up never leaves one of those still running
  // toward a tour nobody can reach any more.
  const controllerRef = useRef<AbortController | null>(null);
  // The route this attempt is (or, once running, is expected to keep)
  // matching. Set as soon as `startScenario` knows it — before it even
  // navigates there, if it must — so a route-change effect can tell its
  // own startRoute navigation apart from someone leaving mid-tour, at
  // every stage from setup through a live tour.
  const expectedRouteRef = useRef<string | null>(null);

  /** Stops whatever is currently happening — an in-flight attempt to
   *  start a scenario, or a running tour — without touching the menu's
   *  own open/closed state. Split from `closeHelp` because
   *  `startScenario` needs this half on its own: two scenario picks in
   *  a row must not stack two overlays. */
  const cancelTour = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    cancelRef.current?.();
    cancelRef.current = null;
    expectedRouteRef.current = null;
  }, []);

  const closeHelp = useCallback(() => {
    cancelTour();
    setIsOpen(false);
  }, [cancelTour]);

  const startScenario = useCallback(
    async (id: HelpScenarioId): Promise<void> => {
      cancelTour();

      const scenario = getHelpScenario(id);
      if (scenario === undefined) {
        setUnavailable("That help topic no longer exists.");
        return;
      }

      const controller = new AbortController();
      controllerRef.current = controller;
      expectedRouteRef.current = scenario.startRoute ?? location.pathname;

      setIsOpen(false);

      if (
        scenario.startRoute !== undefined &&
        location.pathname !== scenario.startRoute
      ) {
        navigate(scenario.startRoute);
        const settled = await waitForRoute(scenario.startRoute, controller.signal);
        if (controller.signal.aborted) return;
        if (!settled) {
          appLog.warn("help: startRoute never settled", { id });
          setUnavailable(UNAVAILABLE_MESSAGE);
          return;
        }
      }

      try {
        // Loaded on demand: Driver.js and its CSS have no business in
        // the initial bundle.
        const { runTour } = await import("./TourRenderer.ts");
        if (controller.signal.aborted) return;

        const cancel = await runTour(scenario, {
          signal: controller.signal,
          onUnavailable: (reason) => {
            appLog.warn("help: scenario ended early", { id, reason });
            setUnavailable(UNAVAILABLE_MESSAGE);
          },
        });

        if (controller.signal.aborted) {
          cancel();
          return;
        }
        cancelRef.current = cancel;
      } catch (error) {
        // A lazy chunk can 404 across a deploy (src/sw.ts's own comment
        // on stale precache entries) — the caller is `void
        // startScenario(id)`, so an unhandled rejection here would
        // otherwise reach nobody. This is the one path that would
        // otherwise become silence instead of the required message.
        if (!controller.signal.aborted) {
          appLog.warn("help: failed to start tour", { id, error: String(error) });
          setUnavailable(UNAVAILABLE_MESSAGE);
        }
      }
    },
    [location.pathname, navigate, cancelTour],
  );

  // A tour outlives navigation only by accident — once one is running,
  // any route change away from where it started leaves it spotlighting
  // a detached node. `expectedRouteRef` also covers the setup window
  // (including this same function's own startRoute navigation, which
  // changes `location.pathname` too), so this only ever fires for a
  // route change the current attempt did not itself cause.
  useEffect(() => {
    if (
      expectedRouteRef.current !== null &&
      expectedRouteRef.current !== location.pathname
    ) {
      cancelTour();
    }
  }, [location.pathname, cancelTour]);

  // Unmount must not leave a tour's listeners attached to a torn-down page.
  useEffect(() => () => cancelTour(), [cancelTour]);

  const value = useMemo<HelpContextValue>(
    () => ({
      isOpen,
      openHelp: () => {
        setUnavailable(null);
        setIsOpen(true);
      },
      closeHelp,
      startScenario,
      unavailable,
      dismissUnavailable: () => setUnavailable(null),
    }),
    [isOpen, closeHelp, startScenario, unavailable],
  );

  return <HelpContext.Provider value={value}>{children}</HelpContext.Provider>;
}
