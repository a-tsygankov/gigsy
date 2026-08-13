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

/** Waits for the router to settle on `route` before the tour is built.
 *  Polling beats a timeout: it finishes as soon as it is true. */
async function waitForRoute(route: string, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (window.location.pathname === route) return true;
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  return false;
}

export function HelpProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const cancelRef = useRef<(() => void) | null>(null);

  const closeHelp = useCallback(() => {
    cancelRef.current?.();
    cancelRef.current = null;
    setIsOpen(false);
  }, []);

  const startScenario = useCallback(
    async (id: HelpScenarioId): Promise<void> => {
      const scenario = getHelpScenario(id);
      if (scenario === undefined) {
        setUnavailable("That help topic no longer exists.");
        return;
      }

      setIsOpen(false);

      if (
        scenario.startRoute !== undefined &&
        location.pathname !== scenario.startRoute
      ) {
        navigate(scenario.startRoute);
        if (!(await waitForRoute(scenario.startRoute))) {
          appLog.warn("help: startRoute never settled", { id });
          setUnavailable("This help step is currently unavailable.");
          return;
        }
      }

      // Loaded on demand: Driver.js and its CSS have no business in the
      // initial bundle.
      const { runTour } = await import("./TourRenderer.ts");
      cancelRef.current = await runTour(scenario, {
        onUnavailable: (reason) => {
          appLog.warn("help: scenario ended early", { id, reason });
          setUnavailable("This help step is currently unavailable.");
        },
      });
    },
    [location.pathname, navigate],
  );

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
