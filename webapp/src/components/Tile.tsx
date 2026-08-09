/**
 * Dashboard metric (design system, components/data/Tile): uppercase
 * caption over a big tabular-nums number so money columns align.
 */
export type TileTone = "neutral" | "good" | "warn";

export const TILE_TONE_CLASSES: Record<TileTone, string> = {
  neutral: "text-slate-900",
  good: "text-emerald-700",
  warn: "text-amber-700",
};

export function Tile({
  label,
  value,
  tone = "neutral",
  testId,
}: {
  label: string;
  value: string;
  tone?: TileTone;
  testId: string;
}) {
  return (
    <div className="min-w-0 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="truncate text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </p>
      <p
        data-testid={testId}
        className={`mt-1 text-2xl font-bold tabular-nums tracking-tight ${TILE_TONE_CLASSES[tone]}`}
      >
        {value}
      </p>
    </div>
  );
}
