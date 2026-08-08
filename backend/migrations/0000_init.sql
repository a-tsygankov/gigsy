-- 0000_init: users, clients, gigs, expenses.
--
-- Conventions (docs/plan.md §4): TEXT UUID PKs (client-generated for
-- offline idempotency), epoch-ms INTEGER timestamps, integer cents for
-- money. modified_at is set on insert and bumped on every update —
-- the conflict-resolution signal for the offline sync path.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  google_refresh_token_enc TEXT,
  created_at INTEGER NOT NULL,
  modified_at INTEGER NOT NULL
);

CREATE TABLE clients (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  contact_info TEXT,
  notes TEXT,
  created_at INTEGER NOT NULL,
  modified_at INTEGER NOT NULL
);
CREATE INDEX idx_clients_user_name ON clients(user_id, name);

CREATE TABLE gigs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  client_id TEXT REFERENCES clients(id),
  status TEXT NOT NULL DEFAULT 'lead'
    CHECK (status IN ('lead','confirmed','completed','paid')),
  location TEXT,
  date_time INTEGER,
  calendar_event_id TEXT,
  amount_offered_cents INTEGER,
  amount_paid_cents INTEGER,
  notes TEXT,
  source TEXT,
  created_at INTEGER NOT NULL,
  modified_at INTEGER NOT NULL
);
CREATE INDEX idx_gigs_user_date ON gigs(user_id, date_time);
CREATE INDEX idx_gigs_user_status ON gigs(user_id, status);
CREATE INDEX idx_gigs_client ON gigs(client_id);

CREATE TABLE expenses (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  gig_id TEXT REFERENCES gigs(id),
  amount_cents INTEGER NOT NULL,
  category TEXT,
  receipt_r2_key TEXT,
  notes TEXT,
  created_at INTEGER NOT NULL,
  modified_at INTEGER NOT NULL
);
CREATE INDEX idx_expenses_user ON expenses(user_id);
CREATE INDEX idx_expenses_gig ON expenses(gig_id);
