-- 0003_drafts: AI-extracted capture drafts (docs/plan.md §8).
-- A draft is the review gate between capture (photo / forwarded
-- email) and real records — extraction NEVER auto-commits. The
-- original artifact lives in R2 (raw_r2_key, u/<uid>/captures/<id>);
-- extracted_json holds the provider output + fuzzy client match.

CREATE TABLE drafts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  source TEXT NOT NULL CHECK (source IN ('email', 'photo')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'discarded')),
  raw_r2_key TEXT,
  extracted_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  modified_at INTEGER NOT NULL
);
CREATE INDEX idx_drafts_user_status ON drafts(user_id, status);
