# Phase 1: Data Layer + CRUD API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** JWT-guarded, user-scoped CRUD + idempotent offline sync + reports SQL over the Phase 0 schema (docs/plan.md §4–§5).

**Architecture:** Hono routers → thin user-scoped repos (Drizzle on D1) → the 0000_init tables. Auth is verify-only (`sub` claim = user_id); token *issuance* beyond the test/dev helper arrives with Google auth in Phase 2. Multi-tenancy boundary: every repo method takes `userId` from the verified JWT — never from the request body.

**Tech Stack:** Hono 4 (`hono/jwt`), Drizzle 0.36 (d1), zod + @hono/zod-validator, @cloudflare/vitest-pool-workers.

**Branch:** dev-1. No commits without the user's command.

---

### Task 1: Access tokens (`src/auth/tokens.ts`)

**Files:** Create `backend/src/auth/tokens.ts`, `backend/test/tokens.test.ts`

- [x] RED: round-trip issue→verify returns `sub`; expired token rejected; wrong secret rejected; malformed rejected
- [x] GREEN: `issueAccessToken({userId, secret, ttlSeconds, now?})` (HS256 via hono/jwt `sign`), `verifyAccessToken({token, secret})` → `{ userId } | null`
- [x] Tests pass

### Task 2: Auth middleware (`src/middleware/auth.ts`)

**Files:** Create `backend/src/middleware/auth.ts`, `backend/test/auth-middleware.test.ts`; modify `src/index.ts`

- [x] RED: 401 without header / with garbage / expired; 200 + userId visible with valid token (probe route)
- [x] GREEN: `requireAuth` — parses `Authorization: Bearer`, verifies, `c.set("userId", ...)`; `AuthVars` type. Mount CRUD paths behind it in index.ts
- [x] Tests pass

### Task 3: Test DB helper

**Files:** Create `backend/test/helpers/db.ts`; modify `backend/test/env.d.ts` (`*.sql?raw` module decl — already howler-style)

- [x] `applyMigrations(db)`: import `0000_init.sql?raw`, strip `--` comments, split on `;`, run each via `db.prepare().run()`
- [x] `seedUser(db, id, email)` — FKs are enforced; every entity test seeds its user first
- [x] Covered implicitly by every repo/route test

### Task 4–6: Clients / Gigs / Expenses CRUD

**Files per entity:** Create `src/domain/schemas.ts` (zod: ClientInput, GigInput w/ status enum + int cents, ExpenseInput), `src/repos/{clients,gigs,expenses}.ts`, `src/routes/{clients,gigs,expenses}.ts`, `test/{clients,gigs,expenses}-routes.test.ts`; modify `src/index.ts`

Route shape (all under requireAuth):
- `GET /api/<entity>` → list own (400-cap)
- `GET /api/<entity>/:id` → own or 404 (cross-user = 404, never 403 — no existence leak)
- `PUT /api/<entity>/:id` → **upsert by client-generated UUID** (offline idempotency); server sets created_at/modified_at; 400 on zod violation; 404 when the id belongs to another user
- `DELETE /api/<entity>/:id` → own or 404

- [x] RED per entity: 401 unauth; create-via-PUT returns 201-shape; list isolation between two users; update bumps modified_at; invalid payload 400 (gig status enum, non-int cents); delete then 404; cross-user get/put/delete → 404
- [x] GREEN: repo (`list/get/upsert/remove`, all `WHERE user_id = ?`) + router per entity
- [x] Tests pass

### Task 7: Sync (`src/routes/sync.ts`, `src/services/sync.ts`)

`POST /api/sync` body: `{ ops: [{ entity: "client"|"gig"|"expense", id: uuid, op: "upsert"|"delete", payload?, modifiedAt: number }] }` → `{ results: [{ id, status: "applied"|"skipped"|"error", reason? }] }`

Rules: idempotent upsert by UUID; **LWW by modifiedAt** — apply iff no existing row or `incoming.modifiedAt >= existing.modified_at`; stored modified_at = incoming modifiedAt (client edit time is the truth for offline edits); ops for rows owned by another user → error (still per-op, batch continues); zod-validated payloads.

- [x] RED: replayed op is idempotent (1 row, both applied); stale op skipped; newer op wins; cross-user op errors without aborting batch; mixed-entity batch; invalid payload errors per-op
- [x] GREEN: service + route
- [x] Tests pass

### Task 8: Reports (`src/services/reports.ts`, `src/routes/reports.ts`)

`GET /api/reports/summary?from&to&clientId` (ms-epoch bounds on gigs.date_time / expenses.created_at) →
`{ totals: { offeredCents, paidCents, varianceCents, expensesCents, netCents }, byMonth: [{ month: "YYYY-MM", offeredCents, paidCents, expensesCents, netCents }], byClient: [{ clientId, clientName, offeredCents, paidCents }] }`
Month key: `strftime('%Y-%m', date_time/1000, 'unixepoch')`. Raw SQL via D1 prepare in the service (grouped aggregates are clearer as SQL than as query-builder chains).

- [x] RED: totals + variance + net math; month grouping; client grouping (null client bucketed as clientId null); from/to filter; clientId filter; user isolation
- [x] GREEN: service + route
- [x] Tests pass

### Task 9: Verification

- [x] `pnpm -r typecheck && pnpm -r test && pnpm -r build` all green; worker version left for the pre-commit hook to bump; tree left uncommitted on dev-1
