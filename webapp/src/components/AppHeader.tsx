/**
 * Sticky screen header (design system, components/navigation/AppHeader):
 * wordmark, screen title, sync chip, sign out. The scrim is one of the
 * two translucent surfaces in the app. The wordmark doubles as the
 * hidden-console trigger (three quick taps).
 */
import { useAuthState, useServices, useSyncState } from "../lib/app-context.tsx";
import { useConsoleTap } from "./ConsoleProvider.tsx";
import { SyncBadge } from "./SyncBadge.tsx";

export function AppHeader({ title }: { title: string }) {
  const { auth } = useServices();
  const { user } = useAuthState();
  const sync = useSyncState();
  const tap = useConsoleTap();

  return (
    <header
      className="sticky top-0 z-30 border-b border-slate-200 bg-slate-50/90 backdrop-blur
                 pt-[env(safe-area-inset-top)]"
    >
      <div className="mx-auto flex max-w-lg items-center justify-between px-4 py-3">
        <div className="flex items-baseline gap-3">
          {/* The wordmark is plain type — there is no logotype file. */}
          <span
            onClick={tap}
            className="select-none text-lg font-bold tracking-tight text-slate-900"
          >
            Gigsy
          </span>
          <h1 className="text-sm font-medium text-slate-500">{title}</h1>
          {sync !== null && (
            <SyncBadge online={sync.online} pendingCount={sync.pendingCount} />
          )}
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
