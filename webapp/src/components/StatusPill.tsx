/**
 * Gig lifecycle badge (design system, components/feedback/StatusPill):
 * lead → confirmed → completed → paid. The pill's hue is the state —
 * colour carries the meaning an icon normally would. Text stays
 * lowercase always.
 */
import type { GigStatus } from "../lib/types.ts";

export const STATUS_PILL_CLASSES: Record<GigStatus, string> = {
  lead: "bg-slate-100 text-slate-600",
  confirmed: "bg-sky-100 text-sky-700",
  completed: "bg-amber-100 text-amber-700",
  paid: "bg-emerald-100 text-emerald-700",
};

export function StatusPill({ status }: { status: GigStatus }) {
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_PILL_CLASSES[status]}`}
    >
      {status}
    </span>
  );
}
