-- 0014_gig_expected_cents: what a gig is expected to earn, as a column.
--
-- 0013 made a gig payable by the hour, where amount_offered_cents is
-- no longer the fee but an optional OVERRIDE of rate × time. Every
-- money total still summed amount_offered_cents — the dashboard's
-- Expected and unpaid figures, the report's offered/per-month/
-- per-client/still-owed, the unpaid push nudge — so an hourly gig with
-- no override counted as nothing at all: a $50/h eight-hour shift
-- added $0.00 to every one of them.
--
-- Going forward the arithmetic is deliberately NOT expressed in SQL.
-- It lives in src/domain/gig-pay.ts, is duplicated in the webapp, and
-- both copies are pinned by fixtures/gig-pay-vectors.json. A third
-- maintained copy, in a third language, is a third thing to keep in
-- step. Instead src/repos/gigs.ts recomputes this column from that
-- module inside upsert(), the single funnel both the CRUD route and
-- the /api/sync batch pass through, so the stored figure cannot drift
-- from the inputs it was derived from.
--
-- DERIVED AND SERVER-OWNED: never written by a client. It is absent
-- from GigInput (src/domain/schemas.ts) for exactly the reason
-- calendar_event_id is — a client-supplied value would put a number
-- nobody computed into every money total, and the offline clients that
-- feed /api/sync are the ones this app trusts least.
ALTER TABLE gigs ADD COLUMN expected_cents INTEGER;

-- Backfill, part 1: the offer.
--
-- Right for every fixed gig, where the expected figure IS the offer —
-- the first line of expectedCents(). Right for an hourly gig that
-- carries an override too, because there the override replaces the
-- computed figure entirely. NULL copies as NULL, which is also right:
-- a gig with no offer has an unknown value, not a zero one, and zero
-- would read as work that pays nothing.
UPDATE gigs SET expected_cents = amount_offered_cents;

-- Backfill, part 2: the hourly gigs part 1 could not answer for.
--
-- The assumption this migration must NOT make is that no hourly row
-- exists yet. Hourly pay shipped in the release now in production, so
-- rows entered since then may already be sitting in this table. Left
-- at NULL they would be the exact bug this column exists to kill, only
-- worse: COALESCE(expected_cents, 0) would keep the dashboard, both
-- report figures and the nudge at $0.00 while the gig row and the CSV
-- — which fall back to the client-side derivation for a NULL — showed
-- the real $400.00. Today those two agree and are both wrong; that is
-- strictly better than having them disagree.
--
-- So this statement computes the same figure in SQL, ONCE. It is a
-- one-off migration expression, NOT a fourth copy of the derivation to
-- keep in step: nothing reads it after this migration runs, no code
-- path calls it, and every write from here on goes through
-- GigsRepo.upsert instead. If gig-pay.ts changes tomorrow, this
-- statement is history and must not be edited to match — the rows it
-- touched will have been rewritten by the next upsert of each gig.
-- backend/test/gig-expected-cents-backfill.test.ts pins it to the
-- shared vectors so the numbers it wrote were the module's numbers.
--
-- Mirroring workedMinutes()/billableMinutes() exactly:
--   - both stamps or nothing — the CASE has no ELSE, so a shift that
--     started and never ended yields NULL, not "so far";
--   - max(0, …) clamps a break longer than the span, which would
--     otherwise propagate a negative payment;
--   - COALESCE falls back to duration_minutes only when worked minutes
--     are NULL. A worked value of 0 is legitimate and must NOT fall
--     through to the plan — that is the clamp case above;
--   - the divisions are by 60000.0 and 60.0, because SQLite integer
--     division truncates;
--   - SQLite's round() is half-away-from-zero, which is identical to
--     Math.round over the positives this can produce (rate is
--     positiveCents in the write schema, and minutes are clamped at 0).
-- The WHERE clause repeats the minutes expression so a row with
-- neither a work log nor a planned duration is skipped rather than
-- written as NULL — expectedCents() returns null there, and null is
-- what part 1 already left.
UPDATE gigs
SET expected_cents = CAST(
      round(
        hourly_rate_cents * COALESCE(
          CASE
            WHEN work_started_at IS NOT NULL AND work_ended_at IS NOT NULL
            THEN max(
                   0,
                   round((work_ended_at - work_started_at) / 60000.0)
                     - COALESCE(break_minutes, 0)
                 )
          END,
          duration_minutes
        ) / 60.0
      ) AS INTEGER
    )
WHERE pay_type = 'hourly'
  AND amount_offered_cents IS NULL
  AND hourly_rate_cents IS NOT NULL
  AND COALESCE(
        CASE
          WHEN work_started_at IS NOT NULL AND work_ended_at IS NOT NULL
          THEN max(
                 0,
                 round((work_ended_at - work_started_at) / 60000.0)
                   - COALESCE(break_minutes, 0)
               )
        END,
        duration_minutes
      ) IS NOT NULL;
