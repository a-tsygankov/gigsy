/**
 * Small presentational primitives shared by every screen: loading
 * skeleton, empty state with CTA, floating action button, labeled
 * form field.
 */
import { Link } from "react-router-dom";
import type { ReactNode } from "react";
import { btnPrimary } from "./ui.ts";

export function ListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-3" aria-hidden data-testid="skeleton">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-20 animate-pulse rounded-xl bg-slate-200/70" />
      ))}
    </div>
  );
}

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
      <Link to={to} className={`${btnPrimary} mt-4`}>
        {cta}
      </Link>
    </div>
  );
}

export function Fab({ to, label }: { to: string; label: string }) {
  return (
    <Link
      to={to}
      aria-label={label}
      className="fixed bottom-[calc(5rem+env(safe-area-inset-bottom))] right-4 z-40 flex h-14 w-14
                 items-center justify-center rounded-full
                 bg-emerald-600 text-2xl font-light text-white shadow-lg transition-all duration-150
                 hover:bg-emerald-700 hover:shadow-xl focus:outline-none focus-visible:ring-2
                 focus-visible:ring-emerald-500 focus-visible:ring-offset-2"
    >
      +
    </Link>
  );
}

export function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </span>
      {children}
      {error ? <span className="mt-1 block text-xs text-red-600">{error}</span> : null}
    </label>
  );
}
