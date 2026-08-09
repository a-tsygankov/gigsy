/**
 * Pulsing placeholder rows (design system,
 * components/feedback/ListSkeleton) — shown while any list query is
 * pending. The pulse is the product's single keyframe animation.
 */
export function ListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-3" aria-hidden data-testid="skeleton">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-20 animate-pulse rounded-xl bg-slate-200/70" />
      ))}
    </div>
  );
}
