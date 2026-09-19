/**
 * Sticky screen header (design system, components/navigation/AppHeader):
 * wordmark, screen title, sync chip, sign out. The scrim is one of the
 * two translucent surfaces in the app. The wordmark doubles as the
 * hidden-console trigger (three quick taps).
 */
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  useAuthState,
  useServices,
  useSyncEngine,
  useSyncState,
} from "../lib/app-context.tsx";
import { useHelp } from "../help/runtime/HelpProvider.tsx";
import { useConsoleTap } from "./ConsoleProvider.tsx";
import { SyncBadge } from "./SyncBadge.tsx";
import coffeeGif from "../assets/coffee.gif";
import coffeeStill from "../assets/coffee-still.png";

/**
 * The three header controls — coffee, help, settings — share one
 * recipe, so they read as a set and a new one cannot drift from the
 * other two.
 *
 * The control is 44px tall — the design system's tap minimum — and
 * 40px wide, with the paint left small. Same trick as Toggle: the
 * target is finger-sized, the glyph is not. 40 rather than 44 across,
 * and no gap between the three: side by side at 44 + 4px the rings sat
 * 24px apart and read as three separate things; at 40 + 0 they are
 * 16px apart and read as one set, which is what they are. Height keeps
 * the full 44, and 40 is still above the 36px the platform guidelines
 * treat as the floor. Overlapping targets to bring the rings closer
 * still was ruled out: the shared strip would belong to nobody.
 *
 * The glyph is a 24px ring around a mark. For help and settings the
 * mark is a text character — a bare character floating in a header
 * reads as a typo; a ringed one reads as a control — and the design
 * system has no icon set (docs/design-system.md, "Iconography"), so
 * Unicode plus a border is how it draws them. The coffee is the one
 * image, and it wears the same ring at the same size so the three
 * still read as one row. `group` on the control lets the ring darken
 * on hover of the whole target, not just the 24px ring.
 */
const HEADER_CONTROL =
  "group inline-flex h-11 min-w-10 items-center justify-center rounded-xl " +
  "transition-colors hover:bg-slate-200 focus:outline-none " +
  "focus-visible:ring-2 focus-visible:ring-emerald-500";
const HEADER_GLYPH =
  "flex h-6 w-6 items-center justify-center rounded-full border " +
  "border-slate-400 text-sm font-semibold leading-none text-slate-500 " +
  "transition-colors group-hover:border-slate-600 group-hover:text-slate-700";
/** The gear alone is set larger. `⚙︎` at text-sm is a 14px glyph whose
 *  ink is mostly its spokes — inside a 24px ring it read as a speck
 *  beside the "?". text-lg brings its ink to about the "?"'s height;
 *  the ring stays 24px, so the three still line up. Every other ring
 *  class is inherited from HEADER_GLYPH, which is what keeps the test
 *  that compares the three rings honest. */
const GEAR_GLYPH = "text-lg";

export function AppHeader({ title }: { title: string }) {
  const { auth } = useServices();
  const { user } = useAuthState();
  const sync = useSyncState();
  const engine = useSyncEngine();
  const tap = useConsoleTap();
  const { isOpen: helpOpen, openHelp, closeHelp } = useHelp();
  const location = useLocation();
  const navigate = useNavigate();
  const onSettings = location.pathname === "/settings";

  /**
   * The gear on the Settings screen itself closes it — the same
   * control, pressed again, the way the help button closes the sheet
   * it opened. It used to vanish there ("no point linking to the screen
   * you are on"), and a control that disappears the moment you use it
   * reads as broken, not as tidy.
   *
   * "Close" means back where you came from, and that is the history
   * entry before this one — except when there is none: a fresh load
   * of /settings, or a home-screen icon pointing there, has nothing to
   * go back to. React Router marks that first entry with the key
   * "default" (in the browser and in MemoryRouter alike), so it is the
   * one case that goes home instead. `replace`, so Back from home does
   * not bounce through Settings a second time.
   */
  function closeSettings() {
    if (location.key === "default") navigate("/", { replace: true });
    else navigate(-1);
  }

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
        {/* gap-0: the spacing between the rings comes from the controls'
            own width — see HEADER_CONTROL. */}
        <div className="flex items-center gap-0">
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
            {/* The one image in the header: a 48px animated GIF drawn at
                24px (scripts/generate-coffee-icon.mjs derives it from
                the source art). A GIF cannot be paused from CSS, so the
                <picture> hands anyone who asked their device for less
                motion the first frame as a PNG instead — the same cup,
                standing still. The ring is HEADER_GLYPH on the <img>
                itself, so it matches the two text glyphs beside it
                pixel for pixel; `object-cover` fills the ring with the
                disc so no transparent corner shows inside the border.
                `alt=""` plus aria-hidden: the link's own label names it. */}
            <picture>
              <source srcSet={coffeeStill} media="(prefers-reduced-motion: reduce)" />
              <img
                src={coffeeGif}
                alt=""
                aria-hidden="true"
                width={24}
                height={24}
                className={`${HEADER_GLYPH} object-cover`}
              />
            </picture>
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
              paint.

              On /settings it is the same ring, filled, and a button
              that closes the screen (`closeSettings` above) — so the
              gear is the one control that shows where you are AND takes
              you back, which is what a pressed toggle means.
              `aria-pressed` says so for anyone not looking at the fill.
              Same id in both states: every spec and the tour find the
              gear as `settings-link` whichever screen it is on. */}
          {onSettings ? (
            <button
              type="button"
              onClick={closeSettings}
              aria-label="Close Settings"
              aria-pressed="true"
              title="Close Settings"
              data-testid="settings-link"
              className={HEADER_CONTROL}
            >
              <span
                aria-hidden="true"
                className={`${HEADER_GLYPH} ${GEAR_GLYPH} border-slate-600 bg-slate-200 text-slate-800`}
              >
                ⚙︎
              </span>
            </button>
          ) : (
            <Link
              to="/settings"
              aria-label="Settings"
              aria-pressed="false"
              title={user?.email === undefined ? "Settings" : `Settings · ${user.email}`}
              data-testid="settings-link"
              className={HEADER_CONTROL}
            >
              <span aria-hidden="true" className={`${HEADER_GLYPH} ${GEAR_GLYPH}`}>
                ⚙︎
              </span>
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
