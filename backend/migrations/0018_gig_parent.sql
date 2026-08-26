-- A gig can name the gig it came from.
--
-- Two situations, one column. A FOLLOW-UP links back to the job it
-- followed. A SPLIT's children link back to the engagement they came
-- out of. The link is grouping only: each gig keeps its own status,
-- its own money, its own expenses. Nothing is shared or inherited.
--
-- NO REBUILD, unlike 0015 and 0017. SQLite permits a REFERENCES clause
-- on ADD COLUMN provided the column's default is NULL, which it is.
-- This is why `delivered` (0017) shipped first: a self-referencing key
-- on gigs would have forced that rebuild to stage the table against
-- itself.
--
-- NOTHING IS BACKFILLED. Every existing gig gets NULL, which is the
-- right value for a gig that is part of nothing.
--
-- ON DELETE SET NULL: deleting a parent costs the grouping, never the
-- work. Each child is an independent job carrying its own money, so
-- CASCADE would destroy records nobody asked to remove, and refusing
-- the delete would turn a working action into an error.
--
-- THE ACTION IS NOT ASSUMED TO WORK. That D1 accepts this DDL does not
-- prove it honours the action — 0015's header records this instance
-- accepting and silently ignoring PRAGMA foreign_keys=off. A test
-- deletes a real parent and asserts the child survives with a null
-- link. If it turns out D1 does not honour it, GigsRepo.remove clears
-- children explicitly instead; the webapp has to do that locally
-- regardless (lib/local-store.ts).
ALTER TABLE gigs ADD COLUMN parent_gig_id TEXT
  REFERENCES gigs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_gigs_parent ON gigs(parent_gig_id);
