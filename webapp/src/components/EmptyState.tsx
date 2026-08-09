/**
 * Dashed-border empty state (design system,
 * components/feedback/EmptyState) — every list has one, always with a
 * CTA, always naming the user's real work.
 */
import { ButtonLink } from "./Button.tsx";

export function EmptyState({
  title,
  hint,
  cta,
  to,
}: {
  title: string;
  hint: string;
  cta: string;
  to: string;
}) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-white/50 px-6 py-12 text-center">
      <p className="text-sm font-semibold text-slate-700">{title}</p>
      <p className="mt-1 text-sm text-slate-500">{hint}</p>
      <ButtonLink to={to} className="mt-4">
        {cta}
      </ButtonLink>
    </div>
  );
}
