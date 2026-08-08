import { useAuthState, useServices, useSyncState } from "../lib/app-context.tsx";
import { useConsoleTap } from "./ConsoleProvider.tsx";

/** Offline/pending indicator — quiet when everything is synced. */
function SyncBadge() {
  const sync = useSyncState();
  if (sync === null) return null;
  if (!sync.online) {
    return (
      <span
        data-testid="sync-offline"
        className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-medium text-slate-600"
      >
        offline
      </span>
    );
  }
  if (sync.pendingCount > 0) {
    return (
      <span
        data-testid="sync-pending"
        title={`${sync.pendingCount} change(s) waiting to sync`}
        className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700"
      >
        {sync.pendingCount}↑
      </span>
    );
  }
  return null;
}

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
          <SyncBadge />
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
