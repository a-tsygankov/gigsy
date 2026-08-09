/**
 * Quiet connectivity indicator (design system,
 * components/feedback/SyncBadge) — renders nothing when online and
 * fully synced.
 */
export function SyncBadge({
  online,
  pendingCount,
}: {
  online: boolean;
  pendingCount: number;
}) {
  if (!online) {
    return (
      <span
        data-testid="sync-offline"
        className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-medium text-slate-600"
      >
        offline
      </span>
    );
  }
  if (pendingCount > 0) {
    return (
      <span
        data-testid="sync-pending"
        title={`${pendingCount} change(s) waiting to sync`}
        className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700"
      >
        {pendingCount}↑
      </span>
    );
  }
  return null;
}
