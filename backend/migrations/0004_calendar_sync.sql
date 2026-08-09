-- 0004_calendar_sync: per-user sync watermark (docs/plan.md §9).
-- Each cron run processes gigs with modified_at > this value, then
-- advances it — cheap change detection without per-gig bookkeeping.

ALTER TABLE users ADD COLUMN last_calendar_sync_at INTEGER;
