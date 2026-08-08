-- 0001_refresh_tokens: opaque rotating refresh tokens (docs/plan.md §6).
-- Only the SHA-256 hash of a token is ever stored; the raw value goes
-- to the client once and is deleted-on-use (rotation).

CREATE TABLE refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);
