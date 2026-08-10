# Phase 11: Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One screen that owns the knobs currently scattered across the app,
hardcoded, or hidden. Requested 2026-08-10; the list below starts from the
user's and adds what the codebase shows is missing.

## Requested

| Setting | Today | Notes |
| --- | --- | --- |
| Optional `Gigsy: ` prefix on event titles | hardcoded `client — location` | Makes Gigsy events scannable among personal ones. Off by default — it costs title width on a phone. |
| Sync to a **dedicated Gigsy calendar** | everything goes to `primary` | The user asked "general or a new one for Gigsy?" — this makes it a choice. Needs the `calendar` scope (creating a calendar) on top of `calendar.events`, so it re-prompts for consent. |
| See the forwarding email address | exists in code, never surfaced | `u-<userId>@<domain>`. Show it **only** once a domain is configured; otherwise say plainly that it's not switched on yet, rather than displaying an address that bounces. |
| Control notifications | none | Master switch, per-nudge toggles, and the thresholds below. Hosts the Phase 10 opt-in. |
| Force sync all events | none | Clears `last_calendar_sync_at`, so the next run reconsiders every gig. The repair tool for "my calendar looks wrong". |
| Default reminder minutes | hardcoded 60 | Also `useDefault` — let a user who curates their own calendar defaults opt out entirely. |

## Added, because the code says they're missing

- **Account** — email, which Google account the calendar is connected to, sign
  out. Currently sign-out hides in the header and the connected account is
  invisible, which is why a wrong-account connection is so hard to diagnose.
- **App versions** — webapp / worker / schema. They exist only behind three
  taps on the wordmark; a user reporting a problem shouldn't need a secret.
- **Default gig duration** — Phase 9 made duration real; new gigs should be
  able to prefill the user's usual shift instead of "Not set" every time.
- **Currency.** `formatMoney` hardcodes USD. A gig tracker that can only speak
  dollars is a real limit, and the fix is one `Intl.NumberFormat` argument.
- **Nudge thresholds** — stale-lead days and unpaid days, currently constants
  in the push code. They are exactly the sort of number one person finds
  nagging and another finds too quiet.
- **Capture usage** — captures used today against `AI_DAILY_CAP`, so hitting
  the cap is explicable rather than mysterious.
- **Disconnect calendar** — move it here from the dashboard card, where it sits
  awkwardly next to a status line.

**Deliberately not settings:** anything with one defensible answer. Money stays
integer cents, IDs stay UUIDs, sync stays last-write-wins. A setting is a
promise to support both branches forever.

## Decisions

- **Storage is one `settings_json` column on `users`**, not a column per
  setting and not a table. Settings will keep arriving; a JSON blob with a zod
  schema and defaults means adding one is a code change, not a migration. Reads
  go through `parseSettings()`, which fills defaults, so a row written by an
  older version is always valid.
- **Defaults live in one place** (`domain/settings.ts`) and are exported to
  both halves. The calendar sync and push nudges read the user's settings
  rather than constants, which is the whole point.
- **The screen is a normal route** (`/settings`, reached from the header), not
  a sixth tab — five is already the practical limit at 375px, and this is a
  place you visit rarely.
- **Force sync is explicit and confirmed.** It re-pushes every confirmed gig to
  Google; on a large history that is a lot of API calls, so it says so.
- **Nothing here bypasses the review gate.** Settings change future behaviour;
  they never rewrite existing records.

**Branch:** dev-17 (after the Phase 10 backend lands). No commits without the
user's command.

---

### Task 1: Settings storage + schema

**Files:** `migrations/0008_user_settings.sql`, `domain/settings.ts`, `repos/users.ts`, `routes/settings.ts`, tests

- [ ] RED: defaults returned for a user who has never saved; a partial save
      merges rather than replaces; unknown keys are rejected; an unparseable
      blob falls back to defaults instead of failing the request
- [ ] GREEN

### Task 2: Behaviour reads settings

- [ ] Calendar: title prefix, reminder minutes (and "use calendar default"),
      target calendar id
- [ ] Push: nudge thresholds and per-nudge enablement
- [ ] Gig form: default duration; money formatting: currency

### Task 3: Force sync + dedicated calendar

- [ ] `POST /api/calendar/resync` clears the watermark; confirmed in the UI
- [ ] Creating/selecting a Gigsy calendar, with the extra scope handled as a
      re-consent rather than a silent failure

### Task 4: The screen

- [ ] `/settings` built from design-system components; account, calendar,
      notifications, capture, app info; each section explains what it changes
- [ ] e2e: a setting persists across a reload

### Task 5: Docs + verification

- [ ] docs/plan.md §13 Phase 11; §4 note on `settings_json`
- [ ] Full sweep; tree left uncommitted pending the user's command
