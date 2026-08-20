-- Money is allocated to work, not attached to it.
--
-- payments.gig_id could express "this transfer paid for that gig" and
-- nothing else. An agency settling a week in one transfer had to be
-- entered as several fictional payments, each with its own date and its
-- own proof photo, none of which matched the bank statement.
--
-- payments.gig_id is NOT dropped here. Clients that were offline across
-- this release still send it, and a follow-up change to
-- routes/payments.ts (Phase 4 Task 3) is what will translate it into a
-- single allocation going forward — this migration only backfills the
-- allocations that already exist. gig_id goes when no client sends it.
--
-- RE-RUNNABLE, mostly. `d1 migrations apply --remote` posts this file
-- to D1's HTTP query endpoint, which Cloudflare does not document as
-- transactional across statements (the same gap 0015's header explains
-- at length) — a connection drop partway through this file leaves it
-- half-applied and not recorded as done, so whoever notices has to
-- replay the whole file by hand. Verified directly, not assumed: with
-- `CREATE TABLE payment_allocations` and its first index applied by
-- hand to stand in for that partial state, a plain re-run of this file
-- aborted immediately with "table payment_allocations already exists"
-- before a single other statement ran.
--
-- So every CREATE here is IF NOT EXISTS, and the backfill INSERT is
-- guarded against re-adding an allocation for a payment that already
-- has one, the same way 0015 guards its own re-run. The UPDATEs need
-- no such guard: each one recomputes its column from source rows
-- (gigs.client_id, SUM(payment_allocations.amount_cents)) rather than
-- incrementing anything, so running either one twice lands on the same
-- value the second time as the first.
--
-- ONE STATEMENT DOES NOT SELF-HEAL: `ALTER TABLE payments ADD COLUMN`
-- has no conditional form — SQLite rejects `ADD COLUMN IF NOT EXISTS`
-- as a syntax error (checked directly against this D1 instance, not
-- assumed). If a partial failure lands after that ALTER has already
-- run, every statement before it in this file will now no-op safely on
-- re-run, but the ALTER itself will fail with "duplicate column name:
-- client_id" and stop the batch there — before the backfill INSERT or
-- either UPDATE gets a chance to run again. That failure is safe (nothing
-- is lost or corrupted) but not automatic: a human has to recognise it,
-- skip that one statement, and re-run the rest of the file by hand.
CREATE TABLE IF NOT EXISTS payment_allocations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  payment_id TEXT NOT NULL REFERENCES payments(id),
  gig_id TEXT NOT NULL REFERENCES gigs(id),
  amount_cents INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  modified_at INTEGER NOT NULL,
  server_modified_at INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_payment_allocations_user ON payment_allocations(user_id);
CREATE INDEX IF NOT EXISTS idx_payment_allocations_payment ON payment_allocations(payment_id);
CREATE INDEX IF NOT EXISTS idx_payment_allocations_gig ON payment_allocations(gig_id);
CREATE INDEX IF NOT EXISTS idx_payment_allocations_user_server_modified
  ON payment_allocations(user_id, server_modified_at);

-- A payment comes from one client, and its split may only cover that
-- client's gigs. Nullable on purpose: a transfer recorded before you
-- know who sent it is better than no record, and the constraint only
-- bites once a client is named.
ALTER TABLE payments ADD COLUMN client_id TEXT REFERENCES clients(id);
CREATE INDEX IF NOT EXISTS idx_payments_client ON payments(client_id);

-- Derive it from the gig each payment already pointed at. A payment
-- with no gig, or a gig with no client, stays null. Safe to re-run: it
-- always recomputes from gigs.client_id rather than adding to whatever
-- is already there.
UPDATE payments SET client_id = (
  SELECT g.client_id FROM gigs g WHERE g.id = payments.gig_id
)
WHERE gig_id IS NOT NULL;

-- Every existing payment that named a gig becomes one allocation for
-- its whole amount. A payment that named no gig stays unallocated,
-- which is now a state the app can show rather than a hole.
--
-- The NOT EXISTS guard is what makes this safe to re-run: without it, a
-- retry that reaches this statement a second time (payments and gigs
-- unchanged, payment_allocations already populated by the first pass)
-- would insert a second allocation for every payment that already has
-- one, silently doubling every gig total the next statement computes.
INSERT INTO payment_allocations
  (id, user_id, payment_id, gig_id, amount_cents, created_at, modified_at, server_modified_at)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-a' ||
  substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
  user_id, id, gig_id, amount_cents, created_at, modified_at, 0
FROM payments
WHERE gig_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM payment_allocations a WHERE a.payment_id = payments.id
  );

-- The gig totals the backfill implies. From here on this column is
-- server-written only (services/paid-totals.ts, once it exists). Safe
-- to re-run: it is a SUM over whatever rows payment_allocations
-- actually holds, not an increment, so it lands on the same figure
-- whether the INSERT above ran once or — thanks to its own guard —
-- only counted each payment once across several attempts.
UPDATE gigs SET amount_paid_cents = (
  SELECT SUM(a.amount_cents) FROM payment_allocations a WHERE a.gig_id = gigs.id
)
WHERE EXISTS (SELECT 1 FROM payment_allocations a WHERE a.gig_id = gigs.id);
