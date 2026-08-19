-- Hourly pay, and what actually happened on the day.
--
-- The plan columns (date_time, duration_minutes) are untouched: the
-- calendar sync and the availability projection read those, and a
-- record of when work really started must not move a calendar event.
--
-- pay_type defaults to 'fixed' so every existing row keeps its current
-- meaning — amount_offered_cents is the fee, and nothing derives.
ALTER TABLE gigs ADD COLUMN pay_type TEXT NOT NULL DEFAULT 'fixed';
ALTER TABLE gigs ADD COLUMN hourly_rate_cents INTEGER;
ALTER TABLE gigs ADD COLUMN work_started_at INTEGER;
ALTER TABLE gigs ADD COLUMN work_ended_at INTEGER;
-- Total time NOT worked inside the span, not a list of breaks. One
-- number is what people actually know at the end of a shift.
ALTER TABLE gigs ADD COLUMN break_minutes INTEGER;
