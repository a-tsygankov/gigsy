-- 'paid' stops being a status; 'cancelled' becomes one.
--
-- Paid-ness is now derived: a gig is paid when what has been paid
-- against it covers what it is expected to earn (domain/gig-pay.ts).
-- Two sources of truth for the same fact is what this removes — a
-- hand-set 'paid' and a payment record could always disagree, and after
-- payments can span several gigs they would disagree often.
--
-- One-way. A gig marked paid with no payment record behind it becomes
-- 'completed' and will read as unpaid until a payment is recorded
-- against it. That is the accurate reading of the data that exists.
--
-- `status` carries a CHECK constraint set in 0000_init.sql that
-- hardcodes the accepted values. SQLite has no ALTER TABLE for a CHECK
-- constraint, so widening it means rebuilding the table: a copy with
-- the constraint this migration wants, every row carried across (with
-- the 'paid' backfill folded into that copy, so no row can ever exist
-- that would violate the new constraint), the old table dropped, the
-- copy renamed into its place. Every column is named explicitly on
-- both sides rather than relied on by position, so this is safe
-- against the physical column order that years of ALTER TABLE ADD
-- COLUMN (0006, 0008, 0011, 0013, 0014) actually left behind.
CREATE TABLE gigs_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  client_id TEXT REFERENCES clients(id),
  title TEXT,
  status TEXT NOT NULL DEFAULT 'lead'
    CHECK (status IN ('lead','confirmed','completed','cancelled')),
  location TEXT,
  date_time INTEGER,
  duration_minutes INTEGER,
  calendar_event_id TEXT,
  amount_offered_cents INTEGER,
  amount_paid_cents INTEGER,
  expected_cents INTEGER,
  pay_type TEXT NOT NULL DEFAULT 'fixed',
  hourly_rate_cents INTEGER,
  work_started_at INTEGER,
  work_ended_at INTEGER,
  break_minutes INTEGER,
  notes TEXT,
  source TEXT,
  created_at INTEGER NOT NULL,
  modified_at INTEGER NOT NULL,
  server_modified_at INTEGER NOT NULL DEFAULT 0
);

INSERT INTO gigs_new (
  id, user_id, client_id, title, status, location, date_time,
  duration_minutes, calendar_event_id, amount_offered_cents,
  amount_paid_cents, expected_cents, pay_type, hourly_rate_cents,
  work_started_at, work_ended_at, break_minutes, notes, source,
  created_at, modified_at, server_modified_at
)
SELECT
  id, user_id, client_id, title,
  CASE WHEN status = 'paid' THEN 'completed' ELSE status END,
  location, date_time, duration_minutes, calendar_event_id,
  amount_offered_cents, amount_paid_cents, expected_cents, pay_type,
  hourly_rate_cents, work_started_at, work_ended_at, break_minutes,
  notes, source, created_at, modified_at, server_modified_at
FROM gigs;

DROP TABLE gigs;
ALTER TABLE gigs_new RENAME TO gigs;

CREATE INDEX idx_gigs_user_date ON gigs(user_id, date_time);
CREATE INDEX idx_gigs_user_status ON gigs(user_id, status);
CREATE INDEX idx_gigs_client ON gigs(client_id);
CREATE INDEX idx_gigs_user_server_modified ON gigs(user_id, server_modified_at);
