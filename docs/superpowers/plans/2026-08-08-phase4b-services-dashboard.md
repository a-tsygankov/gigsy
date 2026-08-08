# Gig Services + Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two user-requested features. (1) **Gig services**: extra line-items on a gig, addable any time — description, offered payment, paid amount with a link to a payment entry, isCompleted, timestamps, links to gig (and client via the gig). (2) **Payment entries** as a first-class record (amount, related gig, photo/mail confirmation) — services and drill-downs reference them. (3) **Dashboard** home screen: completed-jobs count, expected money, unpaid money with a future-window selector, and drill-downs — unpaid → job list (offered vs paid incl. services) → gig detail; client → jobs grouped past / completed-unpaid / future; payment → amounts + related gig + confirmation image.

**Decisions:**
- A service's client link is **derived through its gig** (no denormalized client_id — one source of truth).
- `confirmation_r2_key` is set **only by the upload endpoint** (server-controlled, user-prefixed R2 keys) — never via PUT/sync payloads.
- Confirmation upload is **online-only** for now (the deferred Phase 5 photo queue will generalize it).
- Dashboard + reports stay **server-computed**; client-jobs grouping is computed **locally** (offline-friendly).
- Money semantics: `expectedCents` = offered (gigs `lead|confirmed` in window + their services); `unpaidCents` = per completed gig, `max(0, offered−paid) + Σ services max(0, offered−paid)`; `completedCount` = gigs `completed|paid` in window.
- Routes rework: `/` becomes the Dashboard (Home tab), gig list moves to `/gigs`.

**Branch:** dev-5 (stacked on dev-4/PR #4). No commits without the user's command.

---

### Task 1: Migration 0002 + schema + repos + CRUD routes

**Files:** `backend/migrations/0002_services_payments.sql`, `src/db/schema.ts` (+payments, +gigServices w/ boolean-mode is_completed), `src/domain/schemas.ts` (+ServiceInput, PaymentInput — no confirmation key field), `src/repos/{services,payments}.ts` (ExpensesRepo shape), `src/routes/{services,payments}.ts`, mounts, tests `test/{services,payments}-routes.test.ts`

- [x] RED: CRUD + isolation + link checks (service.gigId required+owned; service.paymentId owned when set; payment.gigId owned when set); isCompleted round-trips as boolean; 401s
- [x] GREEN; tests pass

### Task 2: Sync entities + dashboard endpoint + confirmation upload

**Files:** `src/routes/sync.ts` (+entities), `src/services/sync.ts` (+handlers), `src/services/dashboard.ts` + `src/routes/reports.ts` (+/dashboard), `src/routes/payments.ts` (+PUT/GET `/:id/confirmation` via RECEIPTS R2), tests

- [x] RED sync: service/payment ops apply + LWW + link errors, mixed batch
- [x] RED dashboard: tiles math per Decisions; unpaidJobs rows carry client name + gig/services offered/paid + outstanding; from/to window; isolation
- [x] RED upload: PUT stores bytes under `u/<userId>/payments/<id>` + sets key + content type; GET streams back; cross-user 404; unauth 401
- [x] GREEN; tests pass

### Task 3: Webapp offline layer v2

**Files:** `src/lib/types.ts` (+Service, Payment), `src/lib/db.ts` (version(2): services, payments), `src/lib/local-store.ts` (+CRUD, byGig queries), `src/lib/sync-engine.ts` (SyncApi + pull), `src/lib/api.ts` (+endpoints incl. getDashboard, upload/fetch confirmation), `src/lib/data-service.ts` (+methods), tests

- [x] RED: store CRUD + outbox for both entities; byGig filtered lists; Dexie v1→v2 upgrade keeps existing rows; engine pulls new entities; api methods hit right URLs with bearer
- [x] GREEN; tests pass

### Task 4: Screens

**Files:** `src/screens/Dashboard.tsx` (+route "/"), Gigs list → "/gigs", `src/screens/GigEdit.tsx` (+Services + Payments sections), `src/screens/ServiceEdit.tsx`, `src/screens/PaymentEdit.tsx` (+confirmation upload/preview), `src/screens/ClientEdit.tsx` (+Jobs grouped), `src/components/TabBar.tsx` (Home/Gigs/Clients/Expenses), `src/App.tsx` routes

- [x] Dashboard: timeframe select (next 30/90/365 days), tiles (completed / expected / unpaid), unpaid-jobs list rows → gig
- [x] GigEdit sections: services (desc, offered→paid, completed toggle, payment chip) + payments list, add links
- [x] ClientEdit jobs groups: Future / Completed unpaid / Past — local computation, rows → gig
- [x] PaymentEdit: amount/gig/date/notes + upload confirmation (online-only) + image preview via authed blob fetch
- [x] Typecheck green

### Task 5: E2E + verification

- [x] e2e (test-auth): dashboard shows tiles; completed unpaid gig w/ service appears in unpaid list with combined outstanding; click-through to gig; service add round-trip
- [x] Full sweep green (backend/webapp/python/e2e); tree left uncommitted on dev-5
