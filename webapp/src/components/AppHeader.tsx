/**
 * Sticky screen header (design system, components/navigation/AppHeader):
 * wordmark, screen title, sync chip, sign out. The scrim is one of the
 * two translucent surfaces in the app. The wordmark doubles as the
 * hidden-console trigger (three quick taps).
 */
import { Link, useLocation } from "react-router-dom";
import {
  useAuthState,
  useServices,
  useSyncEngine,
  useSyncState,
} from "../lib/app-context.tsx";
import { useHelp } from "../help/runtime/HelpProvider.tsx";
import { useConsoleTap } from "./ConsoleProvider.tsx";
import { SyncBadge } from "./SyncBadge.tsx";

/**
 * The three header controls — coffee, help, settings — share one
 * recipe, so they read as a set and a new one cannot drift from the
 * other two.
 *
 * The control is h-11 / min-w-11 — 44px, the design system's tap
 * minimum — with the paint left small. Same trick as Toggle: the
 * target is finger-sized, the glyph is not. They sit next to each
 * other on a phone, and a 24px trio four pixels apart was a mis-tap
 * waiting to happen.
 *
 * The glyph is a 24px ring around a text character. A bare character
 * floating in a header reads as a typo; a ringed one reads as a
 * control. Still pure type: the design system has no icon set
 * (docs/design-system.md, "Iconography") and Unicode plus a border is
 * how it draws marks. `group` on the control lets the ring darken on
 * hover of the whole 44px target, not just the 24px ring.
 */
const HEADER_CONTROL =
  "group inline-flex h-11 min-w-11 items-center justify-center rounded-xl " +
  "transition-colors hover:bg-slate-200 focus:outline-none " +
  "focus-visible:ring-2 focus-visible:ring-emerald-500";
const HEADER_GLYPH =
  "flex h-6 w-6 items-center justify-center rounded-full border " +
  "border-slate-400 text-sm font-semibold leading-none text-slate-500 " +
  "transition-colors group-hover:border-slate-600 group-hover:text-slate-700";

export function AppHeader({ title }: { title: string }) {
  const { auth } = useServices();
  const { user } = useAuthState();
  const sync = useSyncState();
  const engine = useSyncEngine();
  const tap = useConsoleTap();
  const { isOpen: helpOpen, openHelp, closeHelp } = useHelp();
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
            <SyncBadge
              online={sync.online}
              pendingCount={sync.pendingCount}
              stalled={sync.stalled}
              onRetry={() => void engine?.retryNow()}
            />
          )}
        </div>
        {/* Both controls are h-11 — 44px, the design system's tap
            minimum — with the label itself left small. Same trick as
            Toggle: the target is finger-sized, the paint is not. These
            two sit next to each other on a phone, and the one people
            reach for most is Settings; a 24px pair four pixels apart
            was a mis-tap waiting to happen. */}
        <div className="flex items-center gap-1">
          {/* "Buy me a coffee" — one static link to the hosted page, no
              widget, no image API, no script: the whole integration is
              this URL (docs: the BMC page is tied to the account that
              owns the app). `target="_blank"` so the PWA is not left,
              `rel="noopener"` so the opened page cannot script this one.
              Leftmost of the three: the one people reach for least sits
              furthest from the thumb, and Settings keeps the corner it
              has always had. */}
          <a
            href="https://buymeacoffee.com/tsygankov9"
            target="_blank"
            rel="noopener"
            aria-label="Buy me a coffee"
            title="Buy me a coffee"
            data-testid="coffee-link"
            className={HEADER_CONTROL}
          >
            <span aria-hidden="true" className={HEADER_GLYPH}>
              ☕
            </span>
          </a>
          {/* Unlike Settings, help has nowhere it would be pointing at
              itself — it opens the same sheet from every screen,
              /settings included. This is now the only way in: Settings
              used to carry a "Help" group as a second door, and one
              door that works everywhere beat two where one of them
              only opened on a single screen. */}
          {/* Toggles rather than only opening: the natural way to dismiss
              a sheet you opened from a button is to press that button
              again, and a user who does not find the Close button will
              try it. `aria-expanded` is what tells a screen reader the
              same thing the second press does. */}
          <button
            type="button"
            onClick={helpOpen ? closeHelp : openHelp}
            aria-label="Help"
            aria-expanded={helpOpen}
            title="Help"
            data-testid="help-link"
            className={HEADER_CONTROL}
          >
            {/* A ring around the glyph, not a bare "?" — punctuation
                floating in a header reads as a typo, a circled one reads
                as help. Still pure type: the design system has no icon
                set and Unicode plus a border is how it draws marks.
                The open state is not painted here; the sheet itself is
                the indication, and aria-expanded carries it for anyone
                who cannot see the sheet. */}
            <span aria-hidden="true" className={HEADER_GLYPH}>
              ?
            </span>
          </button>
          {/* Settings is a rare destination, so it gets a header link
              rather than a sixth tab — five is already the practical
              limit at 375px. Sign out moved inside it, next to the
              account it signs out of.

              A ringed gear now, not the word: three text-and-ring
              controls in a row read as one set, where a word beside two
              rings read as a label for them. `⚙︎` carries U+FE0E so it
              renders as text in the ring's own colour rather than as a
              colour emoji that ignores the theme. The accessible name
              is still "Settings" — the tour's "Open Settings" step and
              the settings spec find it by id and by name, not by
              paint. Still hidden on /settings: no point linking to the
              screen you are on. */}
          {!onSettings && (
            <Link
              to="/settings"
              aria-label="Settings"
              title={user?.email === undefined ? "Settings" : `Settings · ${user.email}`}
              data-testid="settings-link"
              className={HEADER_CONTROL}
            >
              <span aria-hidden="true" className={HEADER_GLYPH}>
                ⚙︎
              </span>
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
