# Phase 8: Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The roadmap (docs/plan.md §13) is complete; this closes the two
defects it left behind — the documented v1 limitation that deleting a gig
orphans its Google Calendar event, and the last open item in §14 (fallback
behaviour on extraction-provider errors / free-tier exhaustion).

**Decisions (pinning the open items):**

### 1. Orphaned calendar events → a cleanup queue, not an inline delete

- **Where the fix goes: `GigsRepo.remove()`, not the DELETE route.** A gig can
  be deleted two ways — `DELETE /api/gigs/:id` online, or a `delete` op drained
  through `/api/sync` after an offline delete. Both converge on `remove()`, and
  in an offline-first app the sync path is the *common* one. Fixing only the
  route would silently miss it.
- **A tombstone row, not a network call in the request path.** `remove()` reads
  the row first and, when it carried a `calendar_event_id`, writes a
  `calendar_cleanup` row (migration 0005) before deleting the gig. Deleting the
  Google event inline would put a third-party round-trip inside a user-facing
  DELETE and still orphan the event whenever that call failed. A queue row
  survives failures and retries on the next cron pass.
- **Drained by the existing 15-minute cron**, inside `syncUserGigs` — it already
  holds the user id, the D1 handle and an authorised calendar client. A 404/410
  from Google already counts as a successful delete in `CalendarClient`, so an
  event the user removed by hand drains cleanly.
- **Cleanup failures must not block the gig watermark.** The watermark only
  advances when the gig sync itself had no failures; a cleanup row is its own
  retry mechanism and is tracked separately. Conflating them would stall gig
  syncing behind one unreachable event id.
- Rows are keyed by their own id, so a failed drain simply stays queued.

### 2. Extraction fallback → an ordered provider chain

- **`FallbackProvider` wraps an ordered list** and returns the first non-null
  extraction. `providerFromEnv` builds the chain from whichever keys are
  actually configured: Gemini→Anthropic when `AI_PROVIDER=gemini` and
  `ANTHROPIC_API_KEY` is set, the reverse when Anthropic leads, and a single
  provider when only one key exists. `ANTHROPIC_API_KEY` is already in the
  secrets matrix (§11) as optional — this is what it was reserved for.
- **Falling back on `null` (not only on transport errors) is deliberate.** The
  providers already collapse HTTP failures and unparseable replies into the same
  `null`, and for this workload that conflation is *useful*: if one model cannot
  read a crumpled receipt, asking the other is exactly what a person would do.
  The cost is bounded — `AI_DAILY_CAP` caps captures per user per day, so the
  worst case is two provider calls per capture.
- **No change to `capture-service`.** The chain keeps the
  `ExtractedDataT | null` contract, so "every provider failed" still produces
  `extraction-failed` → 502 for photo capture and the fallback draft for email.
- **The stub stays single.** It is dev/e2e only and never has a partner.

**Branch:** dev-11. No commits without the user's command.

---

### Task 1: Cleanup queue — migration + enqueue on delete

**Files:** `migrations/0005_calendar_cleanup.sql`, `src/db/schema.ts`, `src/repos/gigs.ts`, `src/repos/calendar-cleanup.ts`, tests

- [x] RED: deleting a gig that has a `calendar_event_id` enqueues exactly one
      cleanup row for that user; deleting one without an event id enqueues
      nothing; the enqueue happens on the `/api/sync` delete path too; cleanup
      rows are user-scoped
- [x] GREEN; tests pass

### Task 2: Drain the queue in the sync run

**Files:** `src/calendar/sync-service.ts` (+ its result type), tests

- [x] RED (stub client + real D1): a queued cleanup deletes the event and clears
      the row; a 404/410 also clears it; a failed delete leaves the row for the
      next run; a cleanup failure does not hold back the gig watermark
- [x] GREEN; tests pass

### Task 3: Provider fallback chain

**Files:** `src/capture/providers.ts`, tests

- [x] RED: primary success never calls the fallback; primary null falls through
      to the next; all-null yields null; `providerFromEnv` builds the chain only
      when a second key exists; stub stays single and stays non-production
- [x] GREEN; tests pass

### Task 4: Docs + verification

- [x] docs/plan.md §14: close the provider-fallback item; drop the orphaned-event
      limitation note where it appears
- [x] Full sweep: backend + webapp `typecheck`, `test`, `build`, local e2e,
      `python -m unittest discover -s scripts`
- [x] Tree left uncommitted on dev-11 pending the user's command
