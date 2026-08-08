# Phase 4: Offline-First + Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The phone becomes the database (docs/plan.md §7): Dexie is the on-device source of truth, every mutation lands locally + in an outbox, and a sync engine drains the outbox into the already-live `POST /api/sync` (idempotent, LWW). Plus two carried issues: the hidden console's worker logs broke when `/api/debug/*` went behind JWT, and the PWA ships no icons (not installable).

**Architecture:** Screens keep calling the same entity-method shape they already use — a `DataService` facade (`OfflineDataService`) replaces direct `ApiClient` entity calls. Underneath: `LocalStore` (Dexie CRUD + outbox enqueue, one DB per user id for shared-device isolation), `SyncEngine` (drain on online/interval/after-write; pull-merge with LWW), `ApiClient.sync()` for the wire. All I/O injectable; Dexie tested for real via `fake-indexeddb`.

**Deferred within Phase 4:** receipt-photo upload queue (needs the Phase 5 R2 endpoints + capture UI — no orphaned plumbing).

**Branch:** dev-4. No commits without the user's command.

---

### Task 1: Fix — authed worker logs in the hidden console

**Files:** `src/lib/api.ts` (+`getDebugLogs`), `src/components/HiddenConsole.tsx` (`makeConsoleDataSource(api)`), `src/components/ConsoleProvider.tsx` (wire via useServices), tests in `src/lib/api.test.ts` + `src/components/console-data.test.ts`

- [x] RED: `getDebugLogs` sends bearer + parses entries; `makeConsoleDataSource` → entries when 200, null on ApiError/401 (console shows "unreachable" signed out — by design)
- [x] GREEN; tests pass

### Task 2: Fix — PWA icons + favicon (installability)

**Files:** `webapp/scripts/generate-icons.mjs` (sharp; emerald rounded tile + "G" wordmark SVG → PNGs), `public/icons/*` (committed), `vite.config.ts` manifest icons + includeAssets, `index.html` favicon + apple-touch links

- [x] Generate 192/512 (any), 192/512 maskable (safe-zone padding), apple-touch-180, favicon-32/16
- [x] Manifest + index.html wired; build green; icons precached by Workbox

### Task 3: Local DB + LocalStore (TDD via fake-indexeddb)

**Files:** `src/lib/db.ts` (per-user `GigsyUserDB` v1: gigs/clients/expenses keyed `id`, `pendingOps` keyed `[entity+entityId]`), `src/lib/local-store.ts`, `test src/lib/local-store.test.ts`

- [x] RED: `put` writes the row locally (modifiedAt = clock) AND upserts ONE outbox op per entity+id (latest wins); `remove` tombstones locally + enqueues delete op (replacing a pending upsert); `list`/`get` read local; ops survive across store instances (same db)
- [x] GREEN; tests pass

### Task 4: Sync engine (TDD)

**Files:** `src/lib/sync-engine.ts`, `src/lib/api.ts` (+`sync(ops)`), tests

- [x] RED api.sync: POSTs `{ops}` with bearer, returns per-op results
- [x] RED engine.drain: sends pending ops oldest-first; `applied`→op deleted; `skipped(stale)`→op deleted + server copy pulled into local; `error`→op deleted + logged (poison ops must not wedge the queue); network failure → ops retained untouched
- [x] RED engine.pull: server list merges into local — server row wins iff `modifiedAt` newer AND no pending op for that id; local rows with pending ops never clobbered; server-deleted rows (absent remotely, no pending op, previously synced) removed locally
- [x] RED engine.start: drains on `online` event + after `notifyLocalChange()` (debounced); exposes `{pendingCount, online, syncing}` via subscribe
- [x] GREEN; tests pass

### Task 5: OfflineDataService + wiring + sync indicator

**Files:** `src/lib/data-service.ts` (same method names screens already call, backed by LocalStore + engine notify; boot = pull), `src/lib/app-context.tsx` (per-user construction on sign-in, teardown on sign-out), screens swap `useServices().api` → `useData()`, `Header` gets a pending/offline dot fed by engine state, hidden console Settings shows pendingCount

- [x] Screens unchanged in shape; typecheck green; unit tests for service delegation
- [x] GREEN; full suite passes

### Task 6: Verification

- [x] `pnpm -r typecheck && pnpm -r test && pnpm -r build` + python suite green; e2e against local dev green (signed-out flows unchanged); tree left uncommitted on dev-4
