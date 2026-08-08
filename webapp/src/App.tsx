import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { createMultiTapDetector, type MultiTapDetector } from "./lib/multi-tap.ts";
import { HiddenConsole } from "./components/HiddenConsole.tsx";

type Health = { ok: boolean; env: string; ts: number };

/**
 * Phase 0 shell — proves the toolchain end-to-end (Vite + Tailwind +
 * TanStack Query + the /api proxy). Real screens (gig list, capture,
 * reports) land in Phase 3 after the design pass.
 */
export function App() {
  const [consoleOpen, setConsoleOpen] = useState(false);

  // The detector is stateful (tap sequence) — keep one instance for
  // the component's lifetime.
  const tapsRef = useRef<MultiTapDetector | null>(null);
  tapsRef.current ??= createMultiTapDetector({
    onTrigger: () => setConsoleOpen(true),
  });

  const health = useQuery({
    queryKey: ["health"],
    queryFn: async (): Promise<Health> => {
      const res = await fetch("/api/health");
      if (!res.ok) throw new Error(`health ${res.status}`);
      return res.json() as Promise<Health>;
    },
  });

  const apiStatus = health.isPending
    ? "Checking API…"
    : health.isError
      ? "API unreachable — offline-first sync lands in Phase 4"
      : `API online (${health.data.env})`;

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900 flex items-center justify-center p-6">
      <div className="max-w-md w-full rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        <h1
          className="text-3xl font-bold tracking-tight select-none"
          onClick={() => tapsRef.current?.tap()}
        >
          Gigsy
        </h1>
        <p className="mt-2 text-slate-600">
          Personal gig-work tracker — gigs, clients, expenses, and
          fast capture. Under construction.
        </p>
        <p className="mt-6 text-sm text-slate-500" data-testid="api-status">
          {apiStatus}
        </p>
      </div>
      {consoleOpen && <HiddenConsole onClose={() => setConsoleOpen(false)} />}
    </main>
  );
}
