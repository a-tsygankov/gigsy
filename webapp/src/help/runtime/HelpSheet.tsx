/**
 * The header's entry point into help: a bottom sheet wrapping HelpMenu,
 * mounted once at the app root (HelpProvider) so it works from any
 * screen — unlike HelpSection, which only ever lived inside Settings.
 *
 * Shape follows HiddenConsole (the app's only other overlay): fixed to
 * the bottom, rounded top corners, its own scroll region, safe-area
 * padding. `z-50` — one below HelpUnavailableBanner's `z-[51]`, so a
 * failure message raised while this is open is never covered by it.
 */
import { useEffect, useRef } from "react";
import { HelpMenu } from "./HelpMenu.tsx";

export function HelpSheet({ onClose }: { onClose: () => void }) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Spec §7.5: help must be keyboard-operable. HiddenConsole has no
  // Escape handler to copy — this is new, not borrowed.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Move focus into the sheet on open, without trapping it there
  // permanently — a real focus trap is more than this sheet needs, and
  // HiddenConsole doesn't have one either.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="help-sheet-heading"
      data-testid="help-sheet"
      className="fixed inset-x-0 bottom-0 z-50 max-h-[75dvh] overflow-y-auto rounded-t-2xl
                 border-t border-slate-300 bg-white p-4 shadow-2xl
                 pb-[calc(1rem+env(safe-area-inset-bottom))]"
    >
      <div className="flex items-center justify-between">
        <h2
          id="help-sheet-heading"
          ref={headingRef}
          tabIndex={-1}
          className="text-sm font-bold text-slate-800 focus:outline-none"
        >
          Help
        </h2>
        <button
          type="button"
          data-testid="help-sheet-close"
          onClick={onClose}
          className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-600"
        >
          Close
        </button>
      </div>

      <HelpMenu />
    </div>
  );
}
