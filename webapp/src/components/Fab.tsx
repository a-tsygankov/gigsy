/**
 * Floating "+" (design system, components/navigation/Fab) — the add
 * action on every list screen. Floats above the tab bar, padded for
 * the home-indicator safe area.
 */
import { Link } from "react-router-dom";

export function Fab({ to, label }: { to: string; label: string }) {
  return (
    <Link
      to={to}
      aria-label={label}
      className="fixed bottom-[calc(5rem+env(safe-area-inset-bottom))] right-4 z-40 flex h-14 w-14
                 items-center justify-center rounded-full
                 bg-emerald-600 text-2xl font-light text-on-accent shadow-lg transition-all duration-150
                 hover:bg-accent-hover hover:shadow-xl focus:outline-none focus-visible:ring-2
                 focus-visible:ring-emerald-500 focus-visible:ring-offset-2"
    >
      +
    </Link>
  );
}
