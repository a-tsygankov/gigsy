/**
 * A full-screen modal panel (design system, components/overlay/Sheet).
 *
 * The app's first overlay that is part of the design system rather than
 * of one feature. HelpSheet (help/runtime/HelpSheet.tsx) is the model —
 * `role="dialog"`, `aria-modal`, Escape closes, focus moves to the
 * heading — and is deliberately left as it is: it is a bottom sheet in
 * the help tint, and its job is to sit OVER the screen it explains.
 * This one is the opposite. It takes the whole viewport, because what
 * it holds (the gig picker: a search box, a filter panel and enough
 * rows to scan) needs the whole screen on a phone, and it wears the
 * card surface, because what is inside it is the app's own content
 * rather than commentary on it.
 *
 * Three things HelpSheet does not do, and this does:
 *
 *   - Focus goes BACK on close, to whatever had it before the sheet
 *     opened. A picker that leaves a keyboard user at the top of the
 *     document after every choice is a picker they cannot fill a form
 *     with.
 *   - Body scroll is locked while open. The sheet has its own scroll
 *     region; without the lock, a flick past the end of the list moves
 *     the form underneath instead, and the form is where the user
 *     lands when the sheet closes.
 *   - It renders through a portal to <body>. Its callers put the trigger
 *     inside `Field`, which wraps children in a `<label>` — and a
 *     dialog inside a label inherits the label's layout, and its clicks
 *     re-target the label's control.
 *
 * No focus trap, for the same reason HelpSheet has none: the sheet is
 * short-lived, Escape is always a way out, and a trap is more than
 * either needs. `z-50` matches HelpSheet — one below
 * HelpUnavailableBanner's `z-[51]`, so a help failure raised while a
 * sheet is open is never covered by it.
 *
 * Renders NOTHING while closed rather than a hidden panel: the children
 * are a list that may be hundreds of rows, and a picker sits on every
 * payment split row.
 */
import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "./Button.tsx";

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  /** The heading, and the dialog's accessible name. */
  title: string;
  /** The dialog's own id. Its Close button suffixes it: "-close". */
  testId: string;
  children: ReactNode;
}

export function Sheet({ open, onClose, title, testId, children }: SheetProps) {
  if (!open) return null;
  return createPortal(
    <SheetPanel onClose={onClose} title={title} testId={testId}>
      {children}
    </SheetPanel>,
    document.body,
  );
}

/**
 * The open sheet. Split from `Sheet` so that mounting IS opening: every
 * effect below runs on mount and cleans up on unmount, which is what
 * makes "restore what was there before" a plain cleanup rather than a
 * state machine over an `open` flag.
 */
function SheetPanel({
  onClose,
  title,
  testId,
  children,
}: Omit<SheetProps, "open">) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const headingId = `${testId}-heading`;

  // Escape closes, as HelpSheet's does. On `document`, not the panel:
  // the panel only hears keys while something inside it has focus, and
  // the search box loses focus the moment the user taps a filter chip.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Focus: in on mount, back on unmount. The element is captured
  // before the heading takes focus, or "what had it before" would be
  // the heading itself. Guarded on `isConnected` — the caller may have
  // re-rendered the trigger away (a removed split row) while the sheet
  // was open, and focusing a detached node is a silent no-op that
  // leaves focus on <body>, which is the case this exists to prevent.
  useEffect(() => {
    const before = document.activeElement;
    headingRef.current?.focus();
    return () => {
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  }, []);

  // The lock restores the PREVIOUS value rather than clearing the
  // property, so a page that set its own overflow keeps it.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={headingId}
      data-testid={testId}
      className="fixed inset-0 z-50 flex flex-col bg-white"
    >
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
        <h2
          id={headingId}
          ref={headingRef}
          tabIndex={-1}
          className="truncate text-base font-bold text-slate-900 focus:outline-none"
        >
          {title}
        </h2>
        <Button
          variant="ghost"
          size="sm"
          // 44px tall — the tap minimum docs/design-system.md sets —
          // with `sm` padding so it stays a small button beside the
          // heading, the same recipe DateTimeField's Clear uses.
          className="min-h-11 shrink-0"
          data-testid={`${testId}-close`}
          onClick={onClose}
        >
          Close
        </Button>
      </div>
      {/* Its own scroll region, with the safe-area padding HelpSheet
          carries: on a phone the last row would otherwise sit under
          the home indicator. `min-h-0` lets the flex child shrink to
          the viewport instead of growing with its content. */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
        {children}
      </div>
    </div>
  );
}
