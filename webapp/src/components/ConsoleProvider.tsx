/**
 * One tap-detector + one HiddenConsole for the whole app — the
 * wordmark in the Login screen and the Header share the same 3-tap
 * trigger via useConsoleTap().
 */
import { createContext, useContext, useRef, useState, type ReactNode } from "react";
import { createMultiTapDetector, type MultiTapDetector } from "../lib/multi-tap.ts";
import { HiddenConsole } from "./HiddenConsole.tsx";

const ConsoleContext = createContext<() => void>(() => undefined);

export function useConsoleTap(): () => void {
  return useContext(ConsoleContext);
}

export function ConsoleProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const detectorRef = useRef<MultiTapDetector | null>(null);
  detectorRef.current ??= createMultiTapDetector({
    onTrigger: () => setOpen(true),
  });

  return (
    <ConsoleContext.Provider value={() => detectorRef.current?.tap()}>
      {children}
      {open && <HiddenConsole onClose={() => setOpen(false)} />}
    </ConsoleContext.Provider>
  );
}
