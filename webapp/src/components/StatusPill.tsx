import type { GigStatus } from "../lib/types.ts";

// Status → color mapping from the Phase 3 design spec.
const STYLES: Record<GigStatus, string> = {
  lead: "bg-slate-100 text-slate-600",
  confirmed: "bg-sky-100 text-sky-700",
  completed: "bg-amber-100 text-amber-700",
  paid: "bg-emerald-100 text-emerald-700",
};

export function StatusPill({ status }: { status: GigStatus }) {
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STYLES[status]}`}
    >
      {status}
    </span>
  );
}
