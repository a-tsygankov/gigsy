-- 0011_gig_title: an optional name for a gig.
--
-- Nullable, because most gigs are identified by who they are for and
-- need nothing else. It earns its place when that is ambiguous — two
-- shifts for the same agency in one week. Where it is absent the UI
-- falls back to the first line of notes, which is where people were
-- already writing this.
ALTER TABLE gigs ADD COLUMN title TEXT;
