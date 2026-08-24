-- 'delivered' joins the lifecycle, between 'completed' and payment.
--
-- For work whose output is handed over separately from the job being
-- finished, 'completed' had to mean both "I finished" and "the client
-- has it". This splits them.
--
-- 'paid' is NOT re-added. Migration 0015 removed it because paid-ness
-- is derived from payment_allocations (domain/gig-pay.ts), and a
-- hand-set status beside a payment record is two sources of truth for
-- one fact. 'cancelled' stays, for the same reason it was added.
--
-- 'delivered' is NOT sequence-enforced against payment: a deposit can
-- clear before delivery and a balance after, so no order is enforced.
--
-- THE SERVER DOES NOT ACCEPT 'delivered' YET. This migration only makes
-- the column able to hold it. src/db/schema.ts's GIG_STATUSES still
-- lists four, so PUT /api/gigs rejects 'delivered' at the Zod layer
-- until the enum change lands -- Task 2 of this feature, named here the
-- same way 0016's header named routes/payments.ts as its own follow-up.
-- Widening storage before validation is the safe order:
-- a column that permits a value nothing writes is inert, whereas a
-- server that writes a value the column refuses is an outage.
--
-- WHY A REBUILD: `status` carries a CHECK constraint hardcoded in
-- 0000_init.sql and rewritten by 0015. SQLite has no ALTER TABLE for a
-- CHECK, so widening it means a copy carrying the new constraint, every
-- row moved across with columns named explicitly on BOTH sides, the old
-- table dropped, the copy renamed in. Naming columns explicitly is what
-- makes this safe against the physical column order that 0006, 0008,
-- 0011, 0013 and 0014's ALTER TABLE ADD COLUMNs actually left behind.
--
-- HARDER THAN 0015: four tables now hold a foreign key into gigs.id --
-- expenses (0000), gig_services and payments (0002), and
-- payment_allocations (0016). 0015 handled three; the fourth is new.
-- D1 enforces foreign keys inside migrations (PRAGMA foreign_keys=off
-- is accepted and silently ignored, and PRAGMA defer_foreign_keys does
-- not survive between statements -- both established against this D1
-- instance in 0015's header). DROP TABLE performs an implicit DELETE
-- FROM first, refused the instant any child still points at a row
-- about to disappear. So all four stage, empty, and restore.
--
-- NOTHING IS BACKFILLED. Unlike 0015, which rewrote 'paid' rows, this
-- only widens what is permitted. Every gig keeps the status it had.
--
-- ATOMICITY, AND THE ONE WINDOW THAT DOES NOT SELF-HEAL.
-- `d1 migrations apply --local` runs this file through db.batch(), one
-- transaction. `--remote`, the one the deploy job actually runs, posts it
-- to D1's HTTP query endpoint, which Cloudflare does not document as
-- transactional across statements (0015's header establishes this at
-- length). So a connection dropped partway leaves this file half applied
-- and not recorded as done. That is why it is written to be RE-RUN rather
-- than merely to be correct once: every CREATE is IF NOT EXISTS, every
-- DELETE is a no-op against an already-empty table, and the rebuild's
-- INSERT is filtered to rows it has not already copied. Re-running from
-- the top repeats no destructive step and duplicates no row. The IF NOT
-- EXISTS on the four stage tables is load-bearing, not decoration: a
-- retry that re-created them would overwrite the only surviving copy of
-- every child row with the emptied tables and lose all four for good.
--
-- The exception is the two-statement window between DROP TABLE gigs and
-- ALTER TABLE gigs_new RENAME TO gigs. In it there is no table named
-- `gigs`; gigs_new, already fully populated and correct, is the only copy
-- of the data. A retry from the top reaches its own "INSERT INTO gigs_new
-- ... FROM gigs" and fails outright with `no such table: main.gigs`,
-- because the source it reads from is exactly what this window lacks.
-- Nothing is lost — nothing here ever drops or overwrites gigs_new, and
-- the stage tables still hold every child row — but nothing finishes
-- automatically either.
--
-- RECOVERY, if a deploy dies and re-running gives `no such table:
-- main.gigs`: you are in that window. The data is intact. Rename the
-- rebuild in by hand:
--
--     ALTER TABLE gigs_new RENAME TO gigs;
--
-- Then re-run this file from the top. It will find gigs present,
-- rebuild it once more from itself (a no-op in substance), and restore
-- all four children from the *_stage tables it left intact. Verify with
-- PRAGMA foreign_key_check and by confirming no *_stage table remains.
-- Do NOT try to empty or re-create the stage tables first; they are the
-- only copy of the child rows until that final restore runs.
--
-- Making the window survivable was considered and rejected. Renaming
-- gigs to gigs_old first is strictly worse: SQLite rewrites the child
-- tables' FK clauses to point at gigs_old, so the retry hits the same
-- failure one statement over, with the foreign keys now misdirected too.
-- Closing it properly needs either real cross-statement transactionality
-- (what --remote does not offer) or a conditional "skip if gigs is
-- already gone", which a flat sequence of SQL statements cannot express.
-- Proven, not asserted, by gig-status-delivered-rerun.test.ts.
CREATE TABLE IF NOT EXISTS payment_allocations_stage AS SELECT * FROM payment_allocations;
CREATE TABLE IF NOT EXISTS gig_services_stage AS SELECT * FROM gig_services;
CREATE TABLE IF NOT EXISTS payments_stage AS SELECT * FROM payments;
CREATE TABLE IF NOT EXISTS expenses_stage AS SELECT * FROM expenses;

-- Dependency order, children first: payment_allocations references
-- both payments and gigs, gig_services references both payments and
-- gigs, so both must go before payments. Deleting from an
-- already-empty table (a retry's second pass) is a harmless no-op.
DELETE FROM payment_allocations;
DELETE FROM gig_services;
DELETE FROM payments;
DELETE FROM expenses;

CREATE TABLE IF NOT EXISTS gigs_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  client_id TEXT REFERENCES clients(id),
  title TEXT,
  status TEXT NOT NULL DEFAULT 'lead'
    CHECK (status IN ('lead','confirmed','completed','delivered','cancelled')),
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

-- The NOT IN filter is what makes this statement re-runnable: a retry
-- reaching here with gigs_new already partly populated copies only the
-- rows it has not already copied, rather than erroring on a duplicate
-- primary key. No CASE on status -- nothing is rewritten here.
INSERT INTO gigs_new (
  id, user_id, client_id, title, status, location, date_time,
  duration_minutes, calendar_event_id, amount_offered_cents,
  amount_paid_cents, expected_cents, pay_type, hourly_rate_cents,
  work_started_at, work_ended_at, break_minutes, notes, source,
  created_at, modified_at, server_modified_at
)
SELECT
  id, user_id, client_id, title, status, location, date_time,
  duration_minutes, calendar_event_id, amount_offered_cents,
  amount_paid_cents, expected_cents, pay_type, hourly_rate_cents,
  work_started_at, work_ended_at, break_minutes, notes, source,
  created_at, modified_at, server_modified_at
FROM gigs
WHERE id NOT IN (SELECT id FROM gigs_new);

DROP TABLE IF EXISTS gigs;
ALTER TABLE gigs_new RENAME TO gigs;

CREATE INDEX IF NOT EXISTS idx_gigs_user_date ON gigs(user_id, date_time);
CREATE INDEX IF NOT EXISTS idx_gigs_user_status ON gigs(user_id, status);
CREATE INDEX IF NOT EXISTS idx_gigs_client ON gigs(client_id);
CREATE INDEX IF NOT EXISTS idx_gigs_user_server_modified ON gigs(user_id, server_modified_at);

-- Restore in reverse dependency order: parents before children.
-- payments before both gig_services and payment_allocations, since
-- both reference it. Always running into a table emptied in this same
-- pass, so no NOT-IN filter is needed the way it is for gigs_new.
INSERT INTO expenses SELECT * FROM expenses_stage;
INSERT INTO payments SELECT * FROM payments_stage;
INSERT INTO gig_services SELECT * FROM gig_services_stage;
INSERT INTO payment_allocations SELECT * FROM payment_allocations_stage;

DROP TABLE IF EXISTS payment_allocations_stage;
DROP TABLE IF EXISTS gig_services_stage;
DROP TABLE IF EXISTS payments_stage;
DROP TABLE IF EXISTS expenses_stage;
