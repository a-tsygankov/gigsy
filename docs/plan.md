# Gigsy — Implementation Plan

> Source spec: [`gigsy-handoff.md`](../gigsy-handoff.md). This plan pins the
> stack, data model, and phase order. Each phase gets its own detailed
> TDD plan under `docs/superpowers/plans/` before execution (one plan per
> subsystem — same convention as howler).

## 1. What we're building

A personal tracker for people doing one-off gigs (tasting stands, brand
ambassador work, promo shifts) across multiple agencies/clients.
Solo-user-per-account: each user manages their own gigs, calendar,
expenses, and notes. Not a staffing marketplace — no cross-user
visibility, no admin/agency role.

Core loop: capture a gig lead fast (email forward / photo / manual) →
track it through `lead → confirmed → completed → paid` → attach
expenses/receipts → see monthly and per-client reports.

## 2. Stack (pinned)

Mirrors howler's patterns — reuse patterns, not code:

- **Backend:** Hono on Cloudflare Workers, Drizzle ORM on D1, R2 for
  receipt/gig photos. TypeScript strict.
- **Webapp:** React 18 + Vite + TanStack Query + Tailwind, PWA via
  `vite-plugin-pwa`, deployed to Cloudflare Pages. Offline-first with
  Dexie (IndexedDB) + outbox sync.
- **Auth:** Sign in with Google (ID token → Worker-issued JWT).
  Calendar scope requested in the same flow.
- **AI extraction:** provider-configurable (env, not hardcoded).
  Primary: Gemini Flash free tier. Swappable to Claude without touching
  call sites (`AI_PROVIDER` / `AI_MODEL` vars, `ExtractionProvider`
  interface).
- **No Durable Objects** — no realtime multi-user coordination need.
- **Monorepo:** pnpm workspace `backend/` + `webapp/`, CI via GitHub
  Actions (same deploy pipeline shape as howler).

## 3. Repo layout

```
gigsy/
├── backend/     Hono + Drizzle Worker (HTTP API, cron calendar sync, email handler)
├── webapp/      React + Vite PWA (Cloudflare Pages + Functions /api proxy)
├── scripts/     Workstation deploy helpers + secrets bootstrap
├── docs/        This plan, phase plans under docs/superpowers/plans/
└── gigsy-handoff.md
```

## 4. Data model (D1, migration `0000_init.sql`)

Conventions:
- **IDs are client-generated UUIDs (TEXT)** — required for offline-first
  idempotency (retried syncs upsert by ID instead of creating dupes).
- **Timestamps are epoch milliseconds (INTEGER).** `modified_at` set on
  insert and bumped on every update — the conflict-resolution signal for
  offline sync (last-write-wins by `modified_at`).
- **Money is integer cents** (`amount_offered_cents`), never REAL.
- Every query scoped `WHERE user_id = ?` from the verified JWT claim.
  This is the entire multi-tenancy boundary; never trust a
  client-supplied user ID.

```sql
users
  id TEXT PK, email TEXT UNIQUE NOT NULL,
  google_refresh_token_enc TEXT,           -- AES-GCM, key = REFRESH_TOKEN_ENC_KEY secret
  created_at INTEGER NOT NULL, modified_at INTEGER NOT NULL

clients                                     -- agencies/companies a user works for
  id TEXT PK, user_id TEXT NOT NULL → users.id,
  name TEXT NOT NULL, contact_info TEXT, notes TEXT,
  created_at, modified_at
  INDEX (user_id, name)                     -- uniqueness enforced app-level (fuzzy match)

gigs
  id TEXT PK, user_id TEXT NOT NULL → users.id,
  client_id TEXT NULL → clients.id,
  status TEXT NOT NULL CHECK IN ('lead','confirmed','completed','paid') DEFAULT 'lead',
  location TEXT, date_time INTEGER, calendar_event_id TEXT,
  amount_offered_cents INTEGER, amount_paid_cents INTEGER,
  notes TEXT, source TEXT,                  -- source: manual|email|photo
  created_at, modified_at
  INDEX (user_id, date_time), (user_id, status), (client_id)

expenses
  id TEXT PK, user_id TEXT NOT NULL → users.id,
  gig_id TEXT NULL → gigs.id,
  amount_cents INTEGER NOT NULL, category TEXT,
  receipt_r2_key TEXT, notes TEXT,
  created_at, modified_at
  INDEX (user_id), (gig_id)
```

## 5. API surface (all `/api/*`, JWT-guarded except auth + health)

```
GET  /api/health                          liveness + env echo
POST /api/auth/google                     Google ID token → upsert user → {jwt, refreshToken}
POST /api/auth/refresh                    refresh token → new JWT
GET|POST|PUT|DELETE /api/clients[/:id]    CRUD, user-scoped
GET|POST|PUT|DELETE /api/gigs[/:id]       CRUD + status transitions
GET|POST|PUT|DELETE /api/expenses[/:id]   CRUD
POST /api/sync                            batch outbox drain: [{op, entity, payload}] — idempotent upserts
POST /api/receipts/upload                 R2 upload (returns receipt_r2_key)
GET  /api/receipts/:key                   R2 fetch (user-scoped key prefix)
POST /api/capture/photo                   image → AI extraction → draft gig/expense
GET  /api/drafts / POST /api/drafts/:id/confirm|discard
GET  /api/reports/summary?from&to&client  grouped SQL: by month, by client, offered-vs-paid, net after expenses
```

Email capture has no HTTP route — Cloudflare Email Routing delivers to
the Worker's `email()` handler (per-user forwarding address).

## 6. Auth flow (Phase 2)

1. Webapp uses Google Identity Services; requests profile/email +
   `calendar.events` scope; gets an ID token + auth code.
2. `POST /api/auth/google` — Worker verifies the ID token against
   Google's JWKS, upserts `users`, exchanges the auth code for a Google
   refresh token (needs `GOOGLE_CLIENT_SECRET`), encrypts it (AES-GCM,
   `REFRESH_TOKEN_ENC_KEY`) into `users.google_refresh_token_enc`.
3. Worker issues its own short-lived JWT (HS256, `AUTH_SECRET`, 15 min)
   + opaque refresh token (hashed in D1).
4. Client stores refresh token in **IndexedDB, not cookies** (iOS PWA
   cookie persistence is unreliable); sends JWT as
   `Authorization: Bearer`; Hono JWT middleware extracts `user_id`.

## 7. Offline-first design (Phase 4)

The phone is the database; the Worker/D1 is backup + multi-device sync.

- Dexie (IndexedDB) is source of truth on-device; UI never blocks on
  network. Local DB namespaced per `user_id` (shared-device safety).
- Outbox: every mutation appends to local `pending_ops` (client UUID,
  op type, payload). Sync worker drains on `online` + periodic backoff
  retry via `POST /api/sync`; server upserts idempotently by UUID and
  answers with authoritative `modified_at`s.
- Conflict rule: last-write-wins by `modified_at`; client detects stale
  local copies after reconnect and refreshes.
- Receipt photos queue separately (IndexedDB/OPFS) so slow image
  uploads never block metadata sync.
- `vite-plugin-pwa` (Workbox) precaches the app shell — the PWA loads
  with zero connectivity.

## 8. Fast capture (Phase 5)

- Cloudflare **Email Workers**: per-user forwarding address
  (`u-<token>@<domain>`), `email()` handler parses body + attachments.
  Prereq: a zone with Email Routing enabled (open item — domain TBD).
- Extraction pipeline: `ExtractionProvider` interface with
  `gemini` (primary, free tier) and `anthropic` implementations chosen
  by `AI_PROVIDER`/`AI_MODEL` vars; call sites provider-agnostic.
- Output is always a **draft** — user reviews/confirms; never
  auto-commits. Extracted client name fuzzy-matched against `clients`;
  no match → draft includes a new-client stub for confirmation.
- Rate limiting on extraction endpoints (howler's `ratelimit` unsafe
  binding pattern) — cost control for AI calls.

## 9. Calendar integration (Phase 6)

- Cron trigger (`*/15 * * * *`, commented out in wrangler.toml until
  this phase) iterates users with calendar-relevant changes; uses each
  user's decrypted Google refresh token to mint access tokens.
- Confirmed+ gigs → calendar events; `calendar_event_id` on the gig row
  supports update/delete round-trips. Whether `lead` gigs sync is an
  open item (default: no).

## 10. Reports (Phase 7)

Filtered/grouped SQL over `gigs`/`expenses` — no reporting engine:
by month, by client, offered-vs-paid variance, net income after
expenses. Plus CSV export (open item in handoff, planned here).

## 11. Secrets & config matrix

| Where | Name | Secret? | Purpose |
| --- | --- | --- | --- |
| GitHub Actions | `CLOUDFLARE_API_KEY` | yes | API **token** (Workers+D1+Pages edit) used by deploy.yml |
| GitHub Actions | `CLOUDFLARE_ACCOUNT_ID` | yes | 32-char hex account ID |
| GitHub Actions | `PR_MERMAID_ANTHROPIC_API_KEY` | yes (optional) | PR diagram workflow |
| GitHub Actions | `CLAUDE_CODE_OAUTH_TOKEN` | yes (optional) | PR diagram workflow alt auth |
| Worker secret | `AUTH_SECRET` | yes | HS256 JWT signing key (generate 32B random) |
| Worker secret | `REFRESH_TOKEN_ENC_KEY` | yes | AES-GCM key for `google_refresh_token_enc` (generate 32B random) |
| Worker secret | `GOOGLE_CLIENT_SECRET` | yes | OAuth code → refresh token exchange |
| Worker secret | `GEMINI_API_KEY` | yes | Primary extraction provider |
| Worker secret | `ANTHROPIC_API_KEY` | yes (optional) | Fallback/alt extraction provider |
| wrangler.toml `[vars]` | `GOOGLE_CLIENT_ID` | no | Public OAuth client ID |
| wrangler.toml `[vars]` | `AI_PROVIDER`, `AI_MODEL` | no | Extraction provider selection |
| wrangler.toml `[vars]` | `ENVIRONMENT` | no | Env echo |

Bootstrap: `scripts/setup-secrets.ps1` (placeholders → `gh secret set`
+ `wrangler secret put`; `-Provision` creates D1/R2).

## 12. CI/CD (mirrors howler)

- `deploy.yml`: path-filtered. Backend → typecheck + vitest
  (workers pool), then D1 migrations + `wrangler deploy` on main.
  Webapp → typecheck + build; PR branch preview on Pages + Playwright
  E2E against the preview URL; production Pages deploy on main.
  `workflow_dispatch` escape hatch deploys both.
- `version-check.yml`: PR fails if webapp/worker/schema touched without
  a patch bump (`scripts/check_version_bump.py`, firmware check
  removed).
- `pr-mermaid-diagrams.yml`: consumer stub of
  `a-tsygankov/tools` reusable workflow.

## 13. Phases

- **Phase 0 — Scaffold (this commit).** Monorepo + configs + CI +
  minimal Hono worker (`/api/health`) + minimal PWA shell + initial
  migration + secrets bootstrap script. Acceptance: `pnpm -r typecheck
  && pnpm -r test && pnpm -r build` green; CI green once secrets set
  and D1/R2 provisioned.
- **Phase 1 — Data + CRUD API.** Drizzle schema, repos, JWT middleware
  (verify-only; tests sign their own tokens), clients/gigs/expenses
  CRUD + `/api/sync` idempotent batch upsert + reports SQL. TDD via
  vitest-pool-workers.
- **Phase 2 — Google auth.** ID-token verify, user upsert, JWT +
  refresh issuance, encrypted Google refresh token storage.
- **Phase 3 — Webapp core (online).** Auth UI, gig list/detail,
  client + expense CRUD screens, TanStack Query wiring.
- **Phase 4 — Offline-first.** Dexie + outbox + sync worker +
  photo-upload queue + PWA precache polish.
- **Phase 5 — Capture.** Email Workers + photo capture + provider-
  configurable extraction + draft review flow + fuzzy client match +
  rate limiting.
- **Phase 6 — Calendar sync.** Cron + Google Calendar API round-trips.
- **Phase 7 — Reports + export.** Reports UI, CSV export, notification
  strategy decision.

## 14. Open items (carried from handoff)

- Exact UI flows/screens — needs design pass before Phase 3.
- Notification strategy (reminders for unconfirmed leads / unpaid gigs).
- Whether `lead` gigs sync to calendar (default no).
- Fuzzy-match threshold for client names (avoid silent merges).
- Email Routing domain for per-user forwarding addresses.
- Where model choice lives long-term (global deployment config for now;
  per-user setting deferred) and fallback behavior on provider errors /
  free-tier exhaustion.
