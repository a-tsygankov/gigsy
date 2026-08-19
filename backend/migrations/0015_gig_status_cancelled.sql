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
--
-- The complication a rebuild adds: `payments`, `gig_services` and
-- `expenses` all hold a gig_id referencing gigs.id. D1 enforces
-- foreign keys inside migrations — PRAGMA foreign_keys=off is accepted
-- and silently ignored — and DROP TABLE performs an implicit DELETE
-- FROM first, which is refused the instant any of those three still
-- points at a row about to disappear. PRAGMA defer_foreign_keys does
-- not help either: the deferred-violation counter is only decremented
-- by inserting a matching parent row back, and ALTER TABLE ... RENAME
-- inserts none.
--
-- So every table with a foreign key into gigs.id is staged into a
-- plain copy, emptied, and restored once the new gigs table exists
-- under the same ids — only the status of what used to be 'paid'
-- changes, never an id. Emptying gig_services before payments matters:
-- gig_services.payment_id also references payments.id, so clearing
-- payments first would trip the same FK check this dance exists to
-- get past, just one table over. Restoring is the mirror image.
-- Rebuilding the three child tables instead of just staging them was
-- the other option; staging is less code for tables whose own schema
-- isn't changing here.
--
-- Wrangler applies this whole file as one atomic batch: if any
-- statement below fails, every statement before it is rolled back too,
-- so there is no state where gigs is dropped and the stage tables are
-- not yet restored.

CREATE TABLE gig_services_stage AS SELECT * FROM gig_services;
CREATE TABLE payments_stage AS SELECT * FROM payments;
CREATE TABLE expenses_stage AS SELECT * FROM expenses;

-- Dependency order: gig_services references both gigs and payments.
DELETE FROM gig_services;
DELETE FROM payments;
DELETE FROM expenses;

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

-- Restore, reverse dependency order: payments before gig_services.
INSERT INTO expenses SELECT * FROM expenses_stage;
INSERT INTO payments SELECT * FROM payments_stage;
INSERT INTO gig_services SELECT * FROM gig_services_stage;

DROP TABLE gig_services_stage;
DROP TABLE payments_stage;
DROP TABLE expenses_stage;
