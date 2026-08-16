-- 0012_activity_events: an append-only record of what happened.
--
-- Until now nothing here remembered activity. Refresh tokens are
-- delete-on-read, so all but the most recent sign-in vanished; the
-- worker's log buffer is per-isolate and in memory; and reads left no
-- trace at all. The only evidence of a user's behaviour was the
-- timestamps on rows they happened to write, which cannot distinguish
-- "did nothing" from "wrote nothing".
--
-- This table is what gigsy-analytics reads to answer "who signed in,
-- when, and what did they do" without inferring it.
--
-- Append-only by discipline, not by constraint: nothing in the worker
-- updates a row here, and the only delete is the retention prune on
-- the scheduled handler (src/activity/prune.ts).
CREATE TABLE activity_events (
  id           TEXT PRIMARY KEY,
  -- NULL for events that happen before we know who is asking — a
  -- refused sign-in is the whole reason this column is nullable.
  user_id      TEXT,
  ts           INTEGER NOT NULL,
  -- auth.login | auth.refused | auth.refresh | api.request |
  -- capture.received
  kind         TEXT NOT NULL,
  method       TEXT,
  path         TEXT,
  status       INTEGER,
  duration_ms  INTEGER,
  -- Which record the event concerned, where that is known.
  entity_table TEXT,
  entity_id    TEXT,
  -- Small JSON blob for the rest. Deliberately small: this table gets
  -- a row per request, and detail is the only field with no bound.
  detail_json  TEXT,
  -- Country only, never the address. Enough to tell a CI runner from a
  -- phone, which is what this is for.
  ip_country   TEXT,
  user_agent   TEXT
);

-- The analytics timeline reads one user newest-first; the prune reads
-- everything oldest-first. One index each.
CREATE INDEX idx_activity_events_user_ts ON activity_events(user_id, ts);
CREATE INDEX idx_activity_events_ts ON activity_events(ts);
