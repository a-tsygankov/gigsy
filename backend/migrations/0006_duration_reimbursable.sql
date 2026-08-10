-- 0006_duration_reimbursable (docs/superpowers/plans/2026-08-10-phase9-features.md)
--
-- gigs.duration_minutes: how long the gig runs. Nullable, because
-- existing gigs have no duration and must not acquire a fake one.
-- Stored as a length rather than an end timestamp so it can't go stale
-- when the start moves; the calendar sync uses it instead of assuming
-- four hours.
--
-- expenses.reimbursable: the client is expected to cover this cost.
-- Defaults to 0 so no existing row changes meaning. It records an
-- expectation, not a receipt — reports keep subtracting every expense
-- from net and surface the recoverable amount separately.

ALTER TABLE gigs ADD COLUMN duration_minutes INTEGER;
ALTER TABLE expenses ADD COLUMN reimbursable INTEGER NOT NULL DEFAULT 0;
