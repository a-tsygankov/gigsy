# Phase 7: Reports UI + CSV Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The last roadmap phase (docs/plan.md §13): a Reports screen over the
existing `/api/reports/summary` (shipped in Phase 1, never surfaced), CSV export
for tax/accounting, and a decision on the notification open item (§14).

**Decisions (pinning the open items):**

- **CSV is generated client-side, not by a new endpoint.** Decisive reason: the
  API authenticates with an `Authorization: Bearer` header, so a plain
  `<a download href="/api/…">` cannot carry auth — any server export would have
  to be `fetch` → `Blob` → object URL on the client *anyway*. Generating from the
  local Dexie ledger removes the endpoint entirely **and works offline**, which
  matches the offline-first architecture. No new dependency.
- **Three exports, shaped the way an accountant reads them**, not the way the
  tables are stored:
  1. **Income** — one row per gig *and* one per additional service (both are
     income lines), with date, client, description, offered, paid, outstanding.
  2. **Expenses** — date, category, linked gig, amount, notes.
  3. **Monthly summary** — the on-screen report table.
  Money exports as a plain decimal (`150.00`, no `$`) and dates as ISO
  `YYYY-MM-DD` so spreadsheets parse both without coercion.
- **CSV formula-injection guard is mandatory, not optional.** Capture (Phase 5)
  ingests text from forwarded emails and photos straight into `notes`/`location`,
  so a cell can begin with `=`, `+`, `-`, `@`, tab, or CR and execute on open in
  Excel/Sheets. Such cells are prefixed with an apostrophe. Tested explicitly.
- **Exports honour the on-screen filters.** A CSV that silently disagreed with
  the numbers above it would be worse than no CSV.
- **Filters:** the endpoint already accepts `from`/`to`/`clientId`; only the
  client plumbing is missing. UI is a **preset range** (this year / last year /
  last 12 months / all time / custom) plus a client select — presets because
  date pickers on a phone are the slowest control in the app, custom because
  quarterly tax ranges are the real use case.
- **Navigation: a fifth tab.** The design system documents four tabs, but its
  stated *principle* is "text instead of icons in navigation" — a fifth word
  extends that rather than breaking it. At 375px five tabs give 75px each, well
  over the 44px tap minimum (verified visually). Reports is a top-level money
  destination; burying it behind the dashboard would hide the phase.
- **Notification strategy (docs/plan.md §14) — decided: no push in v1.**
  Reminders are served by two mechanisms that already exist: confirmed gigs land
  on Google Calendar (Phase 6), which fires the platform's own reminders, and the
  dashboard's "waiting to be paid" drill-down is the standing unpaid queue. Web
  Push is deferred, not rejected: on iOS it requires the PWA to be installed to
  the home screen *and* a permission prompt, and it adds subscription lifecycle
  and VAPID key management — real cost for one user with one phone whose gigs are
  already on their calendar. Revisit if leads start going stale in practice.
  Recorded in docs/plan.md §14.

**Branch:** dev-10. No commits without the user's command.

---

### Task 1: CSV library (`webapp/src/lib/csv.ts`)

- [x] RED: RFC 4180 quoting (quotes doubled, fields with comma/quote/newline
      wrapped), CRLF row separator, null/undefined → empty, numbers unquoted;
      formula-injection guard prefixes `=`/`+`/`-`/`@`/tab/CR cells; a guarded
      cell that also needs quoting gets both
- [x] GREEN; `downloadCsv(filename, csv)` DOM helper (Blob + object URL, revoked)

### Task 2: Filters + export row builders

**Files:** `src/lib/api.ts` + `src/lib/data-service.ts` (`getReportSummary(filters)`), `src/lib/report-export.ts`, tests

- [x] RED: `incomeRows` emits a row per gig and per service with the gig's date
      and client resolved; `expenseRows` resolves the linked gig; `summaryRows`
      maps the API month rows; all three respect from/to/clientId; `monthLabel`
      turns `2026-08` → `Aug 2026` and `unscheduled` → `No date` **without**
      timezone drift (no `new Date("2026-08")`)
- [x] GREEN; api/data-service pass filters through as query params

### Task 3: Reports screen

**Files:** `src/screens/Reports.tsx`, `src/App.tsx` route, `src/components/TabBar.tsx`

- [x] Screen from design-system components only; hero Net tile + paid /
      outstanding / expenses; by-month and by-client sections; three export
      buttons; offline note (the summary is server-computed, exports are not)
- [x] Fifth tab renders and fits at 375px

### Task 4: E2E + verification

- [x] e2e: reports tab reachable, totals render, a filter change refetches, an
      export click produces a download with a `.csv` filename
- [x] Full sweep: `pnpm typecheck`, `pnpm test`, `pnpm build`, local e2e
      (wrangler 8787 + vite 5192), browser-pane check at 375px
- [x] Tree left uncommitted on dev-10 pending the user's command
