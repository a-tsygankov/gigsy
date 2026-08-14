/**
 * Floating "+" (design system, components/navigation/Fab) — the add
 * action on every list screen. Floats above the tab bar, padded for
 * the home-indicator safe area.
 */
import { Link } from "react-router-dom";

export function Fab({
  to,
  label,
  testId,
}: {
  to: string;
  label: string;
  /** Optional stable hook for E2E and help scenarios. The accessible
   *  name is "+" plus `label`, which is fine for a screen reader but
   *  useless as a selector once three list screens each have one. */
  testId?: string;
}) {
  return (
    <Link
      to={to}
      aria-label={label}
      data-testid={testId}
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
