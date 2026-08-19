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
-- not help either — verified directly, not assumed: inside a single
-- db.batch() it does survive to the next statement, but issued as its
-- own statement (which is what a migration's DROP/RENAME pair actually
-- are once split apart) it reads back false on the very next one. It
-- has no connection to carry it forward, because each such statement
-- is its own implicit transaction.
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
-- ATOMICITY. `d1 migrations apply --local` runs this file through
-- db.batch(), which is one transaction — verified directly against
-- this file, not assumed. `--remote`, the one the deploy job actually
-- runs, posts it to D1's HTTP query endpoint, which Cloudflare does
-- not document as transactional across statements. That gap is why
-- this file is written to be safely re-run rather than merely correct
-- once: CREATE TABLE IF NOT EXISTS on every table this migration
-- creates, and the rebuild's own INSERT filtered to rows it has not
-- already copied, so re-running from the top after a partial failure
-- repeats no destructive step and duplicates no row.
--
-- The one window that does NOT self-heal: between DROP TABLE gigs and
-- the RENAME two statements later, there is no table named `gigs` —
-- gigs_new, already fully populated and correct, is the only copy of
-- the migrated data. A retry that starts from the top reaches its own
-- "INSERT INTO gigs_new ... FROM gigs" and fails outright, because the
-- source it reads from is exactly the table this window doesn't have.
-- Nothing here is lost — gigs_new is never dropped or overwritten by a
-- retry, only ever added to — but nothing here can finish automatically
-- either, because the statement that would finish it needs a source
-- table that will not exist again until a human reasons about which
-- half of the rebuild actually completed and runs the rest by hand.
-- Closing this fully needs either real cross-statement transactionality
-- (the thing --remote doesn't offer) or a conditional "skip this step
-- if gigs is already gone", which a flat, unconditional sequence of SQL
-- statements has no way to express.

CREATE TABLE IF NOT EXISTS gig_services_stage AS SELECT * FROM gig_services;
CREATE TABLE IF NOT EXISTS payments_stage AS SELECT * FROM payments;
CREATE TABLE IF NOT EXISTS expenses_stage AS SELECT * FROM expenses;

-- Dependency order: gig_services references both gigs and payments.
-- Deleting from an already-empty table (a retry's second pass) is a
-- harmless no-op, not an error.
DELETE FROM gig_services;
DELETE FROM payments;
DELETE FROM expenses;

CREATE TABLE IF NOT EXISTS gigs_new (
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

-- The NOT IN filter is what makes this statement itself re-runnable: a
-- retry that reaches here with gigs_new already partly or fully
-- populated (from an earlier attempt that got this far before failing
-- later) copies only the rows it has not already copied, rather than
-- either erroring on a duplicate primary key or being skipped wholesale
-- by a table-level IF NOT EXISTS the way the CREATE above is.
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
FROM gigs
WHERE id NOT IN (SELECT id FROM gigs_new);

DROP TABLE IF EXISTS gigs;
ALTER TABLE gigs_new RENAME TO gigs;

CREATE INDEX IF NOT EXISTS idx_gigs_user_date ON gigs(user_id, date_time);
CREATE INDEX IF NOT EXISTS idx_gigs_user_status ON gigs(user_id, status);
CREATE INDEX IF NOT EXISTS idx_gigs_client ON gigs(client_id);
CREATE INDEX IF NOT EXISTS idx_gigs_user_server_modified ON gigs(user_id, server_modified_at);

-- Restore, reverse dependency order: payments before gig_services.
-- Always running into a table just emptied by the DELETEs above (in
-- this same pass), so no NOT-IN filter is needed here the way it is
-- for gigs_new.
INSERT INTO expenses SELECT * FROM expenses_stage;
INSERT INTO payments SELECT * FROM payments_stage;
INSERT INTO gig_services SELECT * FROM gig_services_stage;

DROP TABLE IF EXISTS gig_services_stage;
DROP TABLE IF EXISTS payments_stage;
DROP TABLE IF EXISTS expenses_stage;
