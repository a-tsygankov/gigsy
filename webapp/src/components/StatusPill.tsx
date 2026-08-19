/**
 * Gig lifecycle badge (design system, components/feedback/StatusPill):
 * lead → confirmed → completed, with cancelled off to one side rather
 * than at the end of that line — it isn't a stage the work passes
 * through. The pill's hue is the state — colour carries the meaning an
 * icon normally would. Text stays lowercase always.
 *
 * `paid` is deliberately not one of these statuses (migration 0015): it
 * was a status someone set by hand while a payment record said the same
 * thing independently, and the two could disagree. Paid-ness is a
 * derived fact about the money (lib/gig-pay.ts's `isPaid`), not a stage
 * of the work, so it renders as a second badge beside the lifecycle
 * pill rather than folding into it — a completed-and-paid gig can say
 * both at once, which one pill could never do.
 */
import type { GigStatus } from "../lib/types.ts";

export const STATUS_PILL_CLASSES: Record<GigStatus, string> = {
  lead: "bg-slate-100 text-slate-600",
  confirmed: "bg-sky-100 text-sky-700",
  completed: "bg-amber-100 text-amber-700",
  // Its own hue, not slate: sharing lead's colour would make "not yet
  // started" and "never going to happen" look identical at a glance,
  // in a component whose whole job is to carry that distinction in
  // colour. Not red either, despite "cancelled" reading as a natural
  // fit for it: text-red-600 is this app's error signal in seventeen
  // places (Field, LogList, every screen's "Save failed" line,
  // SyncBadge's failure state), so a cancelled gig would look
  // pixel-identical to a sync error. Not emerald — the app's other
  // free curated hue — either: it is the accent/"good news" colour
  // everywhere else (buttons, focus rings, positive money), which is
  // backwards for a job that fell through. violet is new to the
  // palette (colors.css) for exactly this pill.
  cancelled: "bg-violet-100 text-violet-700 line-through",
};

// emerald, not one of the four hues above and not red-50/red-600 (this
// app's error signal, see the comment on `cancelled`): it is free.
// It is also the deliberate choice, not merely a free one — cancelled's
// own comment already calls emerald this app's "accent/'good news'
// colour... positive money" everywhere else (buttons, focus rings,
// Tile's `good` tone), and "money received" is exactly that.
export const PAID_BADGE_CLASSES = "bg-emerald-100 text-emerald-700";

const BADGE = "inline-flex rounded-full px-2 py-0.5 text-xs font-medium";

export function StatusPill({
  status,
  paid = false,
}: {
  status: GigStatus;
  paid?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`${BADGE} ${STATUS_PILL_CLASSES[status]}`}>{status}</span>
      {paid && (
        <span data-testid="paid-badge" className={`${BADGE} ${PAID_BADGE_CLASSES}`}>
          paid
        </span>
      )}
    </span>
  );
}
