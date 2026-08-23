/**
 * A two-or-three option in-page switch, rendered as links because it
 * IS navigation — each option is a real route, so it is shareable,
 * back-buttonable, and works without JavaScript deciding anything.
 *
 * Not `TabBar` (that is the fixed, bottom, app-level nav) and not
 * `Toggle` (that is a boolean switch). Both were considered.
 */
import { NavLink } from "react-router-dom";

export interface SegmentedOption {
  to: string;
  label: string;
}

export function Segmented({
  options,
  testId,
}: {
  options: readonly SegmentedOption[];
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className="flex rounded-lg border border-slate-200 bg-slate-100 p-1"
    >
      {options.map((option) => (
        <NavLink
          key={option.to}
          to={option.to}
          end
          className={({ isActive }) =>
            `flex-1 rounded-md py-2 text-center text-sm font-medium transition-colors duration-150 ` +
            (isActive
              ? "bg-white text-slate-900 shadow-sm"
              : "text-slate-500 hover:text-slate-700")
          }
        >
          {option.label}
        </NavLink>
      ))}
    </div>
  );
}
