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

/** Waits for the router to settle on the scenario's start route before
 *  the tour is built. Polling beats a timeout: it finishes as soon as it
 *  is true. A plain timer, not requestAnimationFrame — rAF never fires
 *  in a backgrounded tab, which would turn a bounded wait into an
 *  indefinite stall.
 *
 *  `settled` is a predicate over the ROUTER's location, not
 *  `window.location.pathname`. The two are not the same thing: they
 *  diverge under a `basename`, under any non-DOM history, and — the
 *  reason this bit — under MemoryRouter, which never touches
 *  `window.location` at all, so the old form could only ever have been
 *  tested against the browser history it happened to assume. Asking the
 *  router what route it is on is both what the rest of this file does
 *  and the only answer that stays right if a basename is ever added. */
async function waitForRoute(
  settled: () => boolean,
  signal: AbortSignal,
  timeoutMs = 5_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !signal.aborted) {
    if (settled()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return settled();
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
  // The router's current path, readable from inside an async callback
  // that was created before the navigation it is waiting on. A ref
  // rather than the captured `location.pathname`, which is a snapshot of
  // the render `startScenario` was built in and therefore never changes
  // while that call is still awaiting.
  const pathnameRef = useRef(location.pathname);
  useEffect(() => {
    pathnameRef.current = location.pathname;
  }, [location.pathname]);

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

  /** Surfaces a failure and makes sure something is open to show it.
   *
   *  `unavailable` alone was not enough: `startScenario` closes the menu
   *  before it can possibly fail, and nothing else reopened it — a
   *  reviewer caught that `unavailable` could end up non-null while
   *  `isOpen` stayed false, which is exactly the state a menu gated on
   *  `isOpen` would never render (spec §10 requires the message plus a
   *  way back to the menu). Reopening here, rather than teaching every
   *  future consumer of `unavailable` to also force `isOpen`, keeps the
   *  invariant — "a message implies something is open to show it" — in
   *  the one place that can break it, and puts the message back in
   *  context with the topic list still there. */
  const reportUnavailable = useCallback((message: string) => {
    setUnavailable(message);
    setIsOpen(true);
  }, []);

  const startScenario = useCallback(
    async (id: HelpScenarioId): Promise<void> => {
      cancelTour();

      const scenario = getHelpScenario(id);
      if (scenario === undefined) {
        reportUnavailable("That help topic no longer exists.");
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
        const startRoute = scenario.startRoute;
        const settled = await waitForRoute(
          () => pathnameRef.current === startRoute,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        if (!settled) {
          appLog.warn("help: startRoute never settled", { id });
          reportUnavailable(UNAVAILABLE_MESSAGE);
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
            // Abort-guarded like every other write in this function. A
            // missing target is reported from a Driver.js hook that can
            // fire seconds after the step began waiting, by which time
            // the user may have closed help or navigated away — and
            // surfacing "This help step is currently unavailable" onto a
            // screen they already left is a message about nothing.
            if (controller.signal.aborted) return;
            appLog.warn("help: scenario ended early", { id, reason });
            reportUnavailable(UNAVAILABLE_MESSAGE);
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
          reportUnavailable(UNAVAILABLE_MESSAGE);
        }
      }
    },
    [location.pathname, navigate, cancelTour, reportUnavailable],
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
