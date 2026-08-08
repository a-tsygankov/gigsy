/**
 * One tap-detector + one HiddenConsole for the whole app — the
 * wordmark in the Login screen and the Header share the same 3-tap
 * trigger via useConsoleTap().
 */
import {
  createContext,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createMultiTapDetector, type MultiTapDetector } from "../lib/multi-tap.ts";
import { useServices } from "../lib/app-context.tsx";
import { HiddenConsole, makeConsoleDataSource } from "./HiddenConsole.tsx";

const ConsoleContext = createContext<() => void>(() => undefined);

export function useConsoleTap(): () => void {
  return useContext(ConsoleContext);
}

export function ConsoleProvider({ children }: { children: ReactNode }) {
  const { api } = useServices();
  const [open, setOpen] = useState(false);
  const detectorRef = useRef<MultiTapDetector | null>(null);
  detectorRef.current ??= createMultiTapDetector({
    onTrigger: () => setOpen(true),
  });
  // Worker logs ride the authed client — /api/debug/* is JWT-guarded.
  const dataSource = useMemo(() => makeConsoleDataSource(api), [api]);

  return (
    <ConsoleContext.Provider value={() => detectorRef.current?.tap()}>
      {children}
      {open && (
        <HiddenConsole onClose={() => setOpen(false)} dataSource={dataSource} />
      )}
    </ConsoleContext.Provider>
  );
}
