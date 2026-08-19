/**
 * Gig lifecycle badge (design system, components/feedback/StatusPill):
 * lead → confirmed → completed, with cancelled off to one side rather
 * than at the end of that line — it isn't a stage the work passes
 * through. The pill's hue is the state — colour carries the meaning an
 * icon normally would. Text stays lowercase always.
 *
 * `paid` is deliberately not one of these (migration 0015): it was a
 * status someone set by hand while a payment record said the same
 * thing independently, and the two could disagree. Paid-ness becomes a
 * derived fact about the money, not a stage of the work — a later
 * phase surfaces it as its own badge.
 */
import type { GigStatus } from "../lib/types.ts";

export const STATUS_PILL_CLASSES: Record<GigStatus, string> = {
  lead: "bg-slate-100 text-slate-600",
  confirmed: "bg-sky-100 text-sky-700",
  completed: "bg-amber-100 text-amber-700",
  cancelled: "bg-slate-100 text-slate-400 line-through",
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
