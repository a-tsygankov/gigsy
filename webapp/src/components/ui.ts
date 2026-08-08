/**
 * Shared class recipes — ONE radius (rounded-xl), one accent
 * (emerald), consistent focus/hover treatments everywhere (design
 * spec, docs/superpowers/plans/2026-08-08-phase3-webapp-core.md).
 */
// Inputs are 16px (text-base): anything smaller makes iOS Safari
// auto-zoom the viewport on focus — the primary devices are phones.
export const inputCls =
  "w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-base text-slate-900 " +
  "placeholder:text-slate-400 transition-shadow duration-150 " +
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:border-emerald-500";

export const btnPrimary =
  "inline-flex items-center justify-center rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white " +
  "shadow-sm transition-all duration-150 hover:bg-emerald-700 hover:shadow " +
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 " +
  "disabled:opacity-50 disabled:pointer-events-none";

export const btnGhost =
  "inline-flex items-center justify-center rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm " +
  "font-medium text-slate-700 transition-colors duration-150 hover:bg-slate-100 " +
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500";

export const btnDanger =
  "inline-flex items-center justify-center rounded-xl border border-red-200 bg-white px-4 py-2 text-sm " +
  "font-medium text-red-600 transition-colors duration-150 hover:bg-red-50 " +
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500";

export const card =
  "block rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition-shadow duration-150 hover:shadow";
