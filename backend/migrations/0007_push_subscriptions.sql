-- 0007_push_subscriptions (docs/superpowers/plans/2026-08-10-phase10-push.md)
--
-- One row per browser/device subscription. The endpoint IS the push
-- service's identifier for it, so it makes a natural primary key:
-- re-subscribing the same browser replaces rather than duplicates.
--
-- p256dh and auth are the subscription's public key material, used to
-- encrypt each payload (RFC 8291). They are not secrets of ours — they
-- are useless without the endpoint, and the endpoint is useless without
-- our VAPID private key.
--
-- last_push_at / last_push_key live on the USER, not here: the cap is
-- "one nudge per person per day", not per device.

CREATE TABLE push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_push_subscriptions_user ON push_subscriptions(user_id);

ALTER TABLE users ADD COLUMN last_push_at INTEGER;
ALTER TABLE users ADD COLUMN last_push_key TEXT;
