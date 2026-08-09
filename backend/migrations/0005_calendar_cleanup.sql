-- 0005_calendar_cleanup: tombstones for calendar events whose gig is
-- gone (docs/superpowers/plans/2026-08-09-phase8-hardening.md).
--
-- Deleting a gig removes the row that held its calendar_event_id, so
-- the cron can no longer see the event to clean up — the v1 limitation
-- this closes. GigsRepo.remove() parks the id here first; the next
-- sync run deletes the event and clears the row. A failed delete
-- simply stays queued and retries.

CREATE TABLE calendar_cleanup (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  calendar_event_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_calendar_cleanup_user ON calendar_cleanup(user_id);
