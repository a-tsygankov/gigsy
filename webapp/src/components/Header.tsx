import { useAuthState, useServices } from "../lib/app-context.tsx";
import { useConsoleTap } from "./ConsoleProvider.tsx";

export function Header({ title }: { title: string }) {
  const { auth } = useServices();
  const { user } = useAuthState();
  const tap = useConsoleTap();

  return (
    <header className="sticky top-0 z-30 border-b border-slate-200 bg-slate-50/90 backdrop-blur">
      <div className="mx-auto flex max-w-lg items-center justify-between px-4 py-3">
        <div className="flex items-baseline gap-3">
          {/* The wordmark doubles as the hidden-console trigger. */}
          <span
            onClick={tap}
            className="select-none text-lg font-bold tracking-tight text-slate-900"
          >
            Gigsy
          </span>
          <h1 className="text-sm font-medium text-slate-500">{title}</h1>
        </div>
        <button
          type="button"
          onClick={() => void auth.signOut()}
          title={user?.email}
          className="rounded-xl px-2 py-1 text-xs font-medium text-slate-500 transition-colors
                     hover:bg-slate-200 hover:text-slate-700 focus:outline-none
                     focus-visible:ring-2 focus-visible:ring-emerald-500"
        >
          Sign out
        </button>
      </div>
    </header>
  );
}
