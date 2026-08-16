/**
 * Quiet connectivity indicator (design system,
 * components/feedback/SyncBadge) — renders nothing when online and
 * fully synced.
 *
 * The stalled state is the loud one, and deliberately so: it means the
 * engine has run out of retries, so what is on screen is all there is.
 * An app that shows an empty list without saying why is telling the
 * user their account is empty, which is a lie. It is a button rather
 * than a chip because the recovery has to be reachable — the
 * alternatives (edit something, toggle airplane mode) are not things
 * anyone would guess.
 */
export function SyncBadge({
  online,
  pendingCount,
  stalled = false,
  onRetry,
}: {
  online: boolean;
  pendingCount: number;
  stalled?: boolean;
  onRetry?: () => void;
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
  // Ranked above the pending count: "we cannot reach the server at all"
  // is the more useful of the two facts, and the count is implied by it.
  if (stalled) {
    return (
      <button
        type="button"
        onClick={onRetry}
        data-testid="sync-error"
        title="Couldn't reach the server — tap to try again"
        className="rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-[10px]
                   font-medium text-red-600 transition-colors hover:bg-red-200
                   focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
      >
        sync failed — retry
      </button>
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
