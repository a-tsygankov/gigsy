/**
 * A two-or-three option in-page switch, rendered as links because it
 * IS navigation — each option is a real route, so it is shareable,
 * back-buttonable, and works without JavaScript deciding anything.
 *
 * Not `TabBar` (that is the fixed, bottom, app-level nav) and not
 * `Toggle` (that is a boolean switch). Both were considered.
 *
 * The closest prior art is the theme picker in `AppearanceSection.tsx`
 * — same visual recipe (`bg-slate-100` track, `bg-white text-slate-900
 * shadow-sm` active pill, `text-slate-500` inactive) but different
 * semantics: it is a `role="radiogroup"` over local component state
 * (the choice never leaves `localStorage`), not a set of real routes
 * with a URL each. The recipe now lives in two places and will drift;
 * that is accepted rather than refactored away here.
 */
import { NavLink } from "react-router-dom";

export interface SegmentedOption {
  to: string;
  label: string;
}

export function Segmented({
  options,
  label,
  testId,
}: {
  options: readonly SegmentedOption[];
  /** Accessible name for the group, e.g. "Money" — announced once for
   *  the pair/trio of links rather than leaving them as indistinguishable
   *  rotor entries. Required: there is no good generic default. */
  label: string;
  testId?: string;
}) {
  return (
    <nav
      data-testid={testId}
      aria-label={label}
      className="flex rounded-lg border border-slate-300 bg-slate-200 p-1"
    >
      {options.map((option) => (
        <NavLink
          key={option.to}
          to={option.to}
          end
          className={({ isActive }) =>
            `flex-1 rounded-md py-3 text-center text-sm font-medium transition-colors duration-150 ` +
            (isActive
              ? "bg-white text-slate-900 shadow-sm"
              : "text-slate-500 hover:text-slate-700")
          }
        >
          {option.label}
        </NavLink>
      ))}
    </nav>
  );
}
