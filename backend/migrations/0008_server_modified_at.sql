-- The calendar watermark compared a SERVER timestamp against
-- `modified_at`, which is stamped by the phone and sent through
-- /api/sync. Two clocks: a gig edited offline carries the time it was
-- typed, not the time it arrived, so anything that uploaded after a
-- cron run sat below the watermark and was never synced again.
--
-- `server_modified_at` is written only by the worker, so it is always
-- monotonic with respect to the watermark. `modified_at` keeps its job
-- (last-write-wins between devices), which genuinely does want the
-- authoring time.
ALTER TABLE gigs ADD COLUMN server_modified_at INTEGER NOT NULL DEFAULT 0;

-- Existing rows: seed from modified_at so already-synced gigs keep
-- their relative order and a backfill isn't forced on every user.
UPDATE gigs SET server_modified_at = modified_at;

CREATE INDEX IF NOT EXISTS idx_gigs_user_server_modified
  ON gigs (user_id, server_modified_at);

-- Repair, not just prevention. Every gig this bug stranded is by
-- definition sitting below its user's watermark, so fixing the column
-- alone leaves them invisible forever. Resetting the watermark forces
-- one full reconciliation on the next run: gigs that already have an
-- event id are re-patched (idempotent), and the ones that were dropped
-- finally get created.
UPDATE users SET last_calendar_sync_at = 0;
