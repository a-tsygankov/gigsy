/**
 * 12px uppercase slate-500 heading — the label voice, and the app's
 * only uppercase text besides form labels (design system,
 * components/data/SectionHeading). Optionally carries an inline text
 * action ("+ Add service") that navigates.
 */
import type { ReactNode } from "react";
import { Link } from "react-router-dom";

export function SectionHeading({
  children,
  actionLabel,
  actionTo,
}: {
  children: ReactNode;
  actionLabel?: string;
  actionTo?: string;
}) {
  const heading = (
    <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
      {children}
    </h2>
  );
  if (actionLabel === undefined || actionTo === undefined) {
    return <div className="mb-2">{heading}</div>;
  }
  return (
    <div className="mb-2 flex items-center justify-between">
      {heading}
      <Link
        to={actionTo}
        className="inline-block py-2 text-xs font-medium text-emerald-700 hover:underline"
      >
        {actionLabel}
      </Link>
    </div>
  );
}
