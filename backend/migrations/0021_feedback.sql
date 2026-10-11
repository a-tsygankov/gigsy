-- 0021_feedback: what a user told the people running Gigsy.
--
-- Until now there was no way to say "something is wrong" from inside
-- the app, let alone with a screenshot. The help sheet gets a "Send
-- feedback" form; this is where what it sends lands
-- (docs/superpowers/specs/2026-10-11-feedback-design.md).
--
-- The row is written BEFORE any mail goes out, and stays whether or
-- not the mail does. Mail is the admin UI — there is no screen that
-- reads this table — but it is also the part most likely to be
-- unconfigured (no Email Sending domain yet, no admins set, the
-- binding missing), and nothing a user took the trouble to write
-- should be lost to a configuration gap. `email_status` says what
-- happened to the mail so the record is honest about it:
--   unsent — nothing was tried: no binding, no sender address, or no
--            admins (routes/feedback.ts decides which, and logs it)
--   sent   — the binding accepted it
--   failed — the binding threw; `email_error` holds the message
--
-- `user_email` is copied onto the row on purpose. The mail needs it,
-- and an admin reading an old row should not have to join users to
-- learn who wrote in — or lose the answer when that user is gone.
--
-- `images_json` is one JSON column, not a child table: a list of
-- { key, type, size, name } for the R2 objects stored under
-- u/<userId>/feedback/<id>/<n>. Nobody queries by image; these rows
-- are append-only records read whole, and a table that exists only to
-- be joined back into a list is a table for its own sake.
--
-- No CHECK on email_status, unlike drafts.status (0003): the set is
-- small today but the word "unsent" already covers three causes, and
-- splitting it later should not need a table rebuild. The TypeScript
-- type (db/schema.ts) is the constraint.
CREATE TABLE feedback (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id),
  user_email     TEXT NOT NULL,
  message        TEXT NOT NULL,
  -- The route the user was on, as the client reported it. Context,
  -- not truth: it is whatever pathname the webapp sent.
  page           TEXT,
  client_version TEXT,
  user_agent     TEXT,
  images_json    TEXT NOT NULL DEFAULT '[]',
  -- unsent | sent | failed — see the header.
  email_status   TEXT NOT NULL,
  email_error    TEXT,
  created_at     INTEGER NOT NULL
);

-- The daily cap (20 per user per UTC day, routes/feedback.ts) is
-- counted from this table the way the capture budget is counted from
-- drafts, so the one read it needs is "this user, since midnight".
CREATE INDEX IF NOT EXISTS idx_feedback_user_created ON feedback(user_id, created_at);
