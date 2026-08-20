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
CREATE TABLE payment_allocations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  payment_id TEXT NOT NULL REFERENCES payments(id),
  gig_id TEXT NOT NULL REFERENCES gigs(id),
  amount_cents INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  modified_at INTEGER NOT NULL,
  server_modified_at INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_payment_allocations_user ON payment_allocations(user_id);
CREATE INDEX idx_payment_allocations_payment ON payment_allocations(payment_id);
CREATE INDEX idx_payment_allocations_gig ON payment_allocations(gig_id);
CREATE INDEX idx_payment_allocations_user_server_modified
  ON payment_allocations(user_id, server_modified_at);

-- A payment comes from one client, and its split may only cover that
-- client's gigs. Nullable on purpose: a transfer recorded before you
-- know who sent it is better than no record, and the constraint only
-- bites once a client is named.
ALTER TABLE payments ADD COLUMN client_id TEXT REFERENCES clients(id);
CREATE INDEX idx_payments_client ON payments(client_id);

-- Derive it from the gig each payment already pointed at. A payment
-- with no gig, or a gig with no client, stays null.
UPDATE payments SET client_id = (
  SELECT g.client_id FROM gigs g WHERE g.id = payments.gig_id
)
WHERE gig_id IS NOT NULL;

-- Every existing payment that named a gig becomes one allocation for
-- its whole amount. A payment that named no gig stays unallocated,
-- which is now a state the app can show rather than a hole.
INSERT INTO payment_allocations
  (id, user_id, payment_id, gig_id, amount_cents, created_at, modified_at, server_modified_at)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-a' ||
  substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
  user_id, id, gig_id, amount_cents, created_at, modified_at, 0
FROM payments
WHERE gig_id IS NOT NULL;

-- The gig totals the backfill implies. From here on this column is
-- server-written only (services/paid-totals.ts).
UPDATE gigs SET amount_paid_cents = (
  SELECT SUM(a.amount_cents) FROM payment_allocations a WHERE a.gig_id = gigs.id
)
WHERE EXISTS (SELECT 1 FROM payment_allocations a WHERE a.gig_id = gigs.id);
