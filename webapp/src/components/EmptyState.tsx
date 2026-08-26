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
  testId,
}: {
  title: string;
  hint?: string;
  /** CTA label; omit for a note with no action to offer. */
  cta?: string;
  to?: string;
  compact?: boolean;
  /** Tags the box itself, so something outside the screen can ask
   *  whether it is on screen. Optional because most empty states are
   *  read by a person and by nothing else.
   *
   *  The one caller that needs it today is the gig list, and the reason
   *  is worth knowing before adding a second: a help scenario cannot
   *  infer "this account owns nothing" from the ABSENCE of the list's
   *  controls, because an absent control also means loading and means
   *  failed. Tagging the empty state gives it the positive form — the
   *  screen is SAYING there is nothing here — which is true in exactly
   *  one of those three states. See help/targets.ts's `GigsEmpty`. */
  testId?: string;
}) {
  const shell = "rounded-xl border border-dashed border-slate-300 bg-white/50 text-center";
  if (compact) {
    return (
      <p className={`${shell} p-4 text-sm text-slate-500`} data-testid={testId}>
        {title}
      </p>
    );
  }
  return (
    <div className={`${shell} px-6 py-12`} data-testid={testId}>
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
