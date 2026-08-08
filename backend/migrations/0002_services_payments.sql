-- 0002_services_payments: payment entries + per-gig additional services.
--
-- payments: first-class money-received records. confirmation_r2_key
-- points at a user-prefixed R2 object (photo / mail screenshot proving
-- payment) and is set ONLY by the upload endpoint, never by client
-- payloads. gig_id links the related job.
--
-- gig_services: extra line-items on a gig, addable at any time —
-- description, promised (offered) payment, paid amount with an
-- optional link to the payment entry that covered it, completion
-- flag. The client link is derived through the gig (one source of
-- truth, no denormalized client_id).

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  gig_id TEXT REFERENCES gigs(id),
  amount_cents INTEGER NOT NULL,
  paid_at INTEGER,
  confirmation_r2_key TEXT,
  notes TEXT,
  created_at INTEGER NOT NULL,
  modified_at INTEGER NOT NULL
);
CREATE INDEX idx_payments_user ON payments(user_id);
CREATE INDEX idx_payments_gig ON payments(gig_id);

CREATE TABLE gig_services (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  gig_id TEXT NOT NULL REFERENCES gigs(id),
  description TEXT NOT NULL,
  amount_offered_cents INTEGER,
  amount_paid_cents INTEGER,
  payment_id TEXT REFERENCES payments(id),
  is_completed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  modified_at INTEGER NOT NULL
);
CREATE INDEX idx_gig_services_user ON gig_services(user_id);
CREATE INDEX idx_gig_services_gig ON gig_services(gig_id);
