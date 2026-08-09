# Phase 6: Google Calendar Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Confirmed gigs appear on the user's Google Calendar and follow edits (docs/plan.md §9), powered by the encrypted refresh tokens Phase 2 already stores. A "Connect calendar" action grants the scope after login (the deliberate Phase 3 deferral).

**Decisions (pinning the open items):**
- **Only `confirmed` gigs with a date sync** — leads never do (handoff question → answered: no). `completed|paid` keep their events (history stays on the calendar).
- **Demotion** (confirmed → lead) deletes the event and clears `calendar_event_id`. ~~**Gig deletion does NOT clean up the event in v1** (the row is gone before cron looks) — documented limitation.~~ **Closed in Phase 8:** `GigsRepo.remove()` parks the event id in a `calendar_cleanup` queue (migration 0005) before deleting the row, and the sync run drains it. See `2026-08-09-phase8-hardening.md`.
- **Change detection:** `users.last_calendar_sync_at` (migration 0004, ADD COLUMN); each run processes gigs with `modified_at > last_calendar_sync_at`. Demotions bump `modified_at`, so they're caught naturally.
- **Events:** primary calendar; summary "clientName — location" (fallbacks), start = `date_time`, end = start + 4h (gigs carry no duration — pinned default), description = notes + "Managed by Gigsy".
- **Auth:** decrypt `google_refresh_token_enc` → mint an access token per run (`refresh_token` grant, GOOGLE_CLIENT_ID/SECRET). A revoked token marks the user disconnected (clears the stored token) instead of failing forever.
- **Cron enabled** (`*/15 * * * *`, the long-commented block) + `POST /api/calendar/sync-now` for instant feedback after connecting.
- **Connect flow:** GIS OAuth **code client** popup (scope `calendar.events`) → authed `POST /api/auth/google-calendar {authCode}` → existing `exchangeAuthCode` + AES-GCM storage. `GET /api/calendar/status` → `{connected, lastSyncAt}`.
- E2E covers the UI's disconnected state + endpoints; the OAuth popup can't run headless — sync logic is unit-tested against a stub CalendarClient (DI, like every external surface).

**Branch:** dev-8. No commits without the user's command.

---

### Task 1: Migration 0004 + CalendarClient

**Files:** `migrations/0004_calendar_sync.sql` (`ALTER TABLE users ADD COLUMN last_calendar_sync_at INTEGER`), schema.ts + UsersRepo (`setLastCalendarSyncAt`, `listConnected`), `src/calendar/google-calendar.ts` (`mintAccessToken`, `CalendarClient` create/patch/delete on primary; injected fetch), tests

- [x] RED: token mint request shape (refresh_token grant) + invalid_grant detection; event create/patch/delete request shapes; non-OK → typed failures
- [x] GREEN; tests pass

### Task 2: Sync orchestration (`src/calendar/sync-service.ts`)

- [x] RED (stub client + real D1): confirmed+dated gig without event → create + store id; edited (modified_at > watermark) → patch; demoted with event → delete + clear id; completed keeps event untouched; dateless confirmed skipped; watermark advances; per-gig client-name lookup in summary
- [x] GREEN; tests pass

### Task 3: Endpoints + cron

**Files:** `src/routes/calendar.ts` (`makeCalendarRouter(deps)`: status / connect / sync-now), auth route reuse (`exchangeAuthCode`), `src/index.ts` scheduled() iterates connected users (per-user errors logged, run continues; invalid_grant → disconnect user), wrangler.toml crons enabled, tests

- [x] RED: connect stores decryptable token (stubbed exchange); 400 on failed exchange; status reflects connected + lastSyncAt; sync-now runs the service (stub client via deps) and 409s when not connected; scheduled() syncs two users independently, one failing doesn't stop the other
- [x] GREEN; tests pass

### Task 4: Webapp + verification

**Files:** `src/lib/google-signin.ts` (+`requestCalendarCode` via GIS code client), `src/lib/api.ts` + data-service (+connectCalendar/getCalendarStatus/calendarSyncNow), Dashboard calendar section (status line, Connect button, Sync now), e2e touch (disconnected state renders)

- [x] api unit tests; typecheck; e2e suite green; full sweep; tree left uncommitted on dev-8
