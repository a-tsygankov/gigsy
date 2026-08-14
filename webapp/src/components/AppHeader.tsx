/**
 * Sticky screen header (design system, components/navigation/AppHeader):
 * wordmark, screen title, sync chip, sign out. The scrim is one of the
 * two translucent surfaces in the app. The wordmark doubles as the
 * hidden-console trigger (three quick taps).
 */
import { Link, useLocation } from "react-router-dom";
import { useAuthState, useServices, useSyncState } from "../lib/app-context.tsx";
import { useHelp } from "../help/runtime/HelpProvider.tsx";
import { useConsoleTap } from "./ConsoleProvider.tsx";
import { SyncBadge } from "./SyncBadge.tsx";

export function AppHeader({ title }: { title: string }) {
  const { auth } = useServices();
  const { user } = useAuthState();
  const sync = useSyncState();
  const tap = useConsoleTap();
  const { openHelp } = useHelp();
  // No point linking to the screen you're already on.
  const onSettings = useLocation().pathname === "/settings";

  return (
    <header
      className="sticky top-0 z-30 border-b border-slate-200 bg-slate-50/90 backdrop-blur
                 pt-[env(safe-area-inset-top)]"
    >
      {/* py-1, not py-3: the controls on the right carry their own 44px
          of tap target (h-11), so the row is already tall enough. Any
          more padding and the header grows for no reason. */}
      <div className="mx-auto flex max-w-lg items-center justify-between px-4 py-1">
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
        {/* Both controls are h-11 — 44px, the design system's tap
            minimum — with the label itself left small. Same trick as
            Toggle: the target is finger-sized, the paint is not. These
            two sit next to each other on a phone, and the one people
            reach for most is Settings; a 24px pair four pixels apart
            was a mis-tap waiting to happen. */}
        <div className="flex items-center gap-1">
          {/* Unlike Settings, help has nowhere it would be pointing at
              itself — it opens the same sheet from every screen,
              including /settings, whose own Help section is a second
              door to this same menu by design. */}
          <button
            type="button"
            onClick={openHelp}
            aria-label="Help"
            title="Help"
            data-testid="help-link"
            className="inline-flex h-11 min-w-11 items-center justify-center rounded-xl px-2
                       text-xs font-medium text-slate-500 transition-colors
                       hover:bg-slate-200 hover:text-slate-700 focus:outline-none
                       focus-visible:ring-2 focus-visible:ring-emerald-500"
          >
            ?
          </button>
          {/* Settings is a rare destination, so it gets a header link
              rather than a sixth tab — five is already the practical
              limit at 375px. Sign out moved inside it, next to the
              account it signs out of. */}
          {!onSettings && (
          <Link
            to="/settings"
            title={user?.email}
            data-testid="settings-link"
            className="inline-flex h-11 items-center rounded-xl px-2 text-xs font-medium
                       text-slate-500 transition-colors hover:bg-slate-200
                       hover:text-slate-700 focus:outline-none focus-visible:ring-2
                       focus-visible:ring-emerald-500"
          >
            Settings
          </Link>
          )}
        </div>
      </div>
    </header>
  );
}
