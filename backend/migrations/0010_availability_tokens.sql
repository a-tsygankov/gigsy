-- 0010_availability_tokens: public availability links (Phase 12).
--
-- The token in /a/<token> is the only thing standing between a
-- stranger and a user's free time, so only its SHA-256 hash is stored
-- — the same rule as refresh_tokens. A leaked database must not hand
-- over live links to anyone's schedule.
--
-- Revocation and expiry are columns rather than a DELETE. Two reasons:
-- "this link stopped working" stays distinguishable from "this link
-- never existed", and one-active-token-per-user is enforced by
-- revoking the old row rather than racing a delete against a read.
--
-- expires_at NULL means the link does not expire on its own; the plan
-- makes expiry optional because a link sent to an agency in March
-- should not still work in December unless the user said so.

CREATE TABLE availability_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER
);

-- Every lookup that is not by hash is "this user's active link".
CREATE INDEX idx_availability_tokens_user ON availability_tokens(user_id);
