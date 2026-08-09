/**
 * Dashed-border empty state (design system,
 * components/feedback/EmptyState) — every list has one, always naming
 * the user's real work.
 *
 * Two densities: the full state carries a CTA and the tall padding a
 * blank screen needs; `compact` is the one-line note used inside a
 * populated screen where there is nothing to act on ("Nothing
 * outstanding — every completed job is paid").
 */
import { ButtonLink } from "./Button.tsx";

export function EmptyState({
  title,
  hint,
  cta,
  to,
  compact = false,
}: {
  title: string;
  hint?: string;
  /** CTA label; omit for a note with no action to offer. */
  cta?: string;
  to?: string;
  compact?: boolean;
}) {
  const shell = "rounded-xl border border-dashed border-slate-300 bg-white/50 text-center";
  if (compact) {
    return <p className={`${shell} p-4 text-sm text-slate-500`}>{title}</p>;
  }
  return (
    <div className={`${shell} px-6 py-12`}>
      <p className="text-sm font-semibold text-slate-700">{title}</p>
      {hint !== undefined && <p className="mt-1 text-sm text-slate-500">{hint}</p>}
      {cta !== undefined && to !== undefined && (
        <ButtonLink to={to} className="mt-4">
          {cta}
        </ButtonLink>
      )}
    </div>
  );
}
