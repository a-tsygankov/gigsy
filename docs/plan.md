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
- **Money is integer cents** (`amount_offered_cents`), never REAL, and
  **strictly positive when present** — payments, expenses, and
  offered/paid amounts reject zero and negatives at the zod boundary
  (CRUD + sync), in the offline data service, and in the forms;
  "no amount" is always `null`, never `0`.
- Every query scoped `WHERE user_id = ?` from the verified JWT claim.
  This is the entire multi-tenancy boundary; never trust a
  client-supplied user ID.
- **Durations are stored as a length, not an end timestamp**
  (`gigs.duration_minutes`, Phase 9) — an end time would duplicate the
  start and go stale whenever it moved. Nullable; the calendar sync
  falls back to 4h when it is unset.
- **Boolean-ish columns are INTEGER 0/1 with a NOT NULL DEFAULT**
  (`expenses.reimbursable`), so adding one never changes the meaning of
  an existing row.

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

### 4.1 Payments and allocations (migration `0016_payment_allocations.sql`)

**Money is allocated to work, not attached to it.**

A **payment** is money received: an amount, a date, optionally a client
and a proof photo. It is a fact about a bank statement, and it exists
whether or not anyone has decided what it paid for.

An **allocation** says which work a payment covers. One payment may have
several, so an agency settling a week in one transfer is one payment
split across the gigs it settled — not several fictional payments, each
with its own date and its own photo, none of which match the statement.
A payment with no allocations is *unallocated*, which is now a state the
app can show rather than a hole.

```sql
payments
  ...,
  client_id TEXT NULL → clients.id,        -- 0016; a split may only cover this client's gigs
  gig_id TEXT NULL → gigs.id,              -- COMPATIBILITY SHIM, see below

payment_allocations                        -- 0016
  id TEXT PK, user_id TEXT NOT NULL → users.id,
  payment_id TEXT NOT NULL → payments.id,
  gig_id TEXT NOT NULL → gigs.id,
  amount_cents INTEGER NOT NULL,
  created_at, modified_at, server_modified_at
  INDEX (user_id), (payment_id), (gig_id), (user_id, server_modified_at)
```

Four rules follow, and everything else in this area is downstream of
them:

- **`gigs.amount_paid_cents` is derived and server-owned.** It is the
  SUM of the allocations pointing at that gig, recomputed server-side;
  no client writes it. A per-gig figure that carried a payment-sized
  number would make every total disagree with the payment that produced
  it — `webapp/src/lib/report-export.test.ts` holds that line for the
  CSV, which must never disagree with the app it was exported from.
- **A payment's split may only cover its own client's gigs**, and the
  server refuses one that does not. `payments.client_id` is nullable on
  purpose: a transfer recorded before you know who sent it is better
  than no record, and the constraint only bites once a client is named.
- **A payment's allocations may not exceed it.** Splitting $150 into
  $100 + $60 is refused, as is lowering a payment below what is already
  allocated out of it. Both doors into the data — the CRUD routes and
  the offline outbox — go through `services/payment-invariants.ts`, so
  neither can become a way around what the other enforces.
- **`payments.gig_id` is a compatibility shim, due for removal.** It is
  still written and still read, because a client that was offline
  across the 0016 release still sends it; `routes/payments.ts`
  translates it into a single allocation on arrival. It goes when no
  client sends it any more — not before, and dropping it is a later
  release.

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
  (`u-<token>@<domain>`), `email()` handler parses the body — the
  plain-text part, or the HTML one reduced to text via HTMLRewriter —
  plus up to two image attachments. PDFs are named on the draft rather
  than read: Gemini and Anthropic need different document blocks, so
  supporting them would push provider knowledge back into the call site
  `providers.ts` keeps clean. Anything skipped is stated on the draft,
  because a draft built from body text alone reads as complete.
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
| Worker secret | `VAPID_PRIVATE_KEY` | yes (optional) | Web Push signing (`GENERATE_VAPID`); rotating it invalidates every subscription |
| Worker secret | `ALLOWED_EMAILS` | yes | Comma-separated list of who may sign in. A secret because the repo is public and these are other people's addresses — not because the values are confidential. Unset means **anyone** with a Google account. Never add it to `[vars]`: the two cannot coexist, and Cloudflare rejects `wrangler secret put` while the var is bound (`already in use`, code 10053) |
| wrangler.toml `[vars]` | `GOOGLE_CLIENT_ID` | no | Public OAuth client ID |
| wrangler.toml `[vars]` | `AI_PROVIDER`, `AI_MODEL` | no | Extraction provider selection |
| wrangler.toml `[vars]` | `VAPID_PUBLIC_KEY` | no | Web Push public key — the browser needs it to subscribe; empty disables push |
| wrangler.toml `[vars]` | `PUSH_SUBJECT` | no | Contact for push services (RFC 8292) |
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
  removed). Runs the version-tooling unit tests first.
- ~~`pr-mermaid-diagrams.yml`~~ **removed 2026-08-11.** It posted
  Claude-generated architecture diagrams as a sticky PR comment on every
  push, which registered as review activity and asked for a response
  each time — six PRs, six false alarms, never anything to act on. The
  diagrams themselves were good; the delivery was the problem.
  Re-enabling is a four-line consumer stub calling
  `a-tsygankov/tools/.github/workflows/pr-mermaid-diagrams.yml`
  (see git history for the exact file). Its inputs are `model` and the
  diff-size caps only — **nothing controls where it posts**, so making
  it quieter means changing the reusable workflow in that repo, not
  this one.

## 12.1 Per-tier versioning (automatic)

Every tier carries its own version; touching a tier bumps it
automatically:

- **webapp** — `webapp/package.json` `.version`, inlined into the
  bundle at build time (`src/lib/versions.ts`).
- **worker** — `backend/package.json` `.version`, inlined via JSON
  import (`src/version.ts`).
- **schema** — the latest applied migration name, read at runtime from
  wrangler's `d1_migrations` tracker; a new numbered `.sql` file IS the
  bump.

Mechanics: the pre-commit hook (`.githooks/pre-commit`, installed by
`pnpm install` via the root `prepare` script) runs
`scripts/bump_versions.py`, which patch-bumps every tier the staged
diff touches — unless that commit already changes the tier's version.
Tier classification lives once in `scripts/version_rules.py`, shared
with the CI gate `check_version_bump.py` (the backstop for hookless
commits). `GET /api/version` reports worker + schema versions.

## 12.2 Hidden debug console (webapp)

Three taps on the app logo (within 600ms per tap —
`src/lib/multi-tap.ts`, configurable) open a console overlay
(`src/components/HiddenConsole.tsx`) that shows, in order:

1. **Versions** on open — client / worker / schema / env, degrading to
   explicit `unreachable` / `none applied` markers offline.
2. **Settings** — the persisted app settings
   (`src/lib/settings.ts`: typed store, injectable storage).
3. **Client logs** — sink-based logger (`src/lib/logger.ts`) with a
   ring buffer + global error/unhandledrejection capture.
4. **Worker logs** — `GET /api/debug/logs`, served from the worker's
   per-isolate ring buffer (`backend/src/logger.ts`); request logging
   excludes `/api/health` and `/api/debug/*` (no feedback loop).

Security note: `/api/debug/*` must move behind the JWT middleware when
Phase 2 lands (TODO in `backend/src/routes/debug.ts`).

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
- **Phase 8 — Hardening.** Calendar-cleanup queue for deleted gigs;
  extraction-provider fallback chain.
- **Phase 9 — Gig duration, reimbursable expenses, location capture.**
  Optional `duration_minutes` (which the calendar then honours instead
  of assuming 4h), an expense flag for costs the client is expected to
  cover, and reverse-geocoded "use my current location" on a gig.
- **Phase 10 — Push notifications.** Reminders for unconfirmed leads
  and unpaid gigs, revisiting the Phase 7 deferral. Needs VAPID keys, a
  `push_subscriptions` table, a service-worker `push` handler, and a
  permission flow — with the caveat that iOS only delivers push to a
  PWA installed to the home screen. The existing 15-minute cron is the
  natural place to evaluate what deserves a nudge.
- **Phase 11 — Settings.** One screen for the knobs currently hardcoded
  or hidden: calendar target and title prefix, reminder minutes, force
  resync, notification thresholds, default gig duration, currency, the
  capture forwarding address, account and app versions. Plus themes
  (system/light/dark) — the one setting that stays device-local rather
  than syncing, since a theme belongs to the surroundings, not the
  person. Stored as a `settings_json` blob on `users` so new settings
  need code, not a migration. See `2026-08-10-phase11-settings.md`.
- **Phase 12 — Client-facing availability.** A link you can send an
  agency that answers "when are you free?" and nothing else: one
  public, unauthenticated page at `/a/<token>`, backed by
  `GET /api/a/:token`. Free time is a projection of gigs plus working
  hours, optionally minus the user's own Google Calendar (read through
  `freebusy`, which returns ranges and never titles). Tokens are
  hashed, revocable and optionally expiring (migration 0010). See
  `2026-08-10-phase12-availability.md`.
- **Phase 13 — Executable help.** One `HelpScenario` model under
  `webapp/src/help/`, consumed by two adapters that read it and own
  nothing: an in-app Driver.js tour and a Playwright suite in
  `webapp/e2e/help/`. The point is to stop maintaining in-app help, UI
  tests, and written docs as three artifacts describing the same
  workflow that quietly drift apart — a UI change that breaks a
  documented workflow fails CI instead of leaving stale help behind,
  *along the path CI takes*. That qualifier is load-bearing: a scenario
  that branches on app state only ever executes one branch per run, so
  a target reachable solely through the other one (`push-toggle` in
  `configure-notifications`, `capture-address-value` in
  `set-up-email-capture`) can be renamed with the suite still green —
  the guarding condition just stops holding and the declared branch runs
  as usual. Those targets are documentation, checked by people.
  A target carries its *kind* (`element` or `switch`) rather than having
  it guessed from the name, because most of this app's switches
  (`Toggle`) tag a 1×1 `sr-only` input while the thing a person actually
  touches is a sibling span; clicking the tagged input in a test passes
  while proving nothing, which is exactly the bug that motivated
  recording the kind explicitly (`push-toggle` is a `<Button>`,
  `toggle-prefix` is a real switch — the name lies both directions).
  Scenarios that branch on legitimate app states — push available vs.
  explained-as-unavailable, capture configured vs. not — declare which
  branch the hermetic CI stack takes in `expectedCiBranches`, and the
  suite asserts the trace matches; an environment change that flips a
  branch fails loudly instead of silently testing something else
  forever. Screenshot and Markdown generation from the same model is
  deferred, deliberately, to a later phase. See
  `docs/gigsy-executable-help-implementation-spec.md`,
  `docs/superpowers/plans/2026-08-13-phase13-executable-help.md`, and
  `docs/help/README.md` for adding a scenario.

### Phase 12 — Client-facing availability (2026-08-10)

**The privacy rule, and it governs everything else here:**

> **Nothing identifying leaves the boundary.** The endpoint returns
> time ranges and a display name the user chose. It must be impossible
> to learn from this page who someone's other clients are, where they
> work, or what they charge.

That is not a nice-to-have. It is the reason the feature was allowed to
exist, and three mechanisms enforce it, in increasing order of how much
they can be trusted:

1. `PublicAvailability` has no field for a client, a place or an amount.
2. `backend/test/availability-routes.test.ts` asserts an **exact key
   set** on the response — not a subset — for a user whose gigs all
   carry a client, a location, an amount and notes. **That test must
   never be deleted.** A new field on the public response should cost a
   deliberate edit to it; that is the point, and it is how `basedOn`
   was reviewed into existence.
3. `GigsRepo.listBusyBetween` selects **two columns**, `date_time` and
   `duration_minutes`. The sensitive fields never enter the worker on
   this path, so the handler cannot serialise what it was never given.
   The rule is structural rather than remembered.

The response carries **free** ranges, never busy ones: "busy 14:00–18:00
at Pier 39" is one join away from a competitor knowing a schedule. The
gap either side of a booking is unavoidably visible — publishing free
time at all reveals that much — but nothing says whether it is a gig, a
dentist or a nap, and there is a test asserting those produce identical
output.

**Reading Google reverses Phase 6's one-way rule, for reads only.**
Gigsy does not know about the dentist or a job booked elsewhere, so a
page built on Gigsy data alone confidently offers slots the user cannot
work — worse than no page, because they have now promised something.
`freebusy` is the only API allowed here because it returns times and
never event content. Nothing from it is ever stored. It is off by
default (`availabilityUseCalendar`) and needs `calendar.freebusy` on
top of `calendar.events` — narrowed from `calendar.readonly`, which
granted every event title and description for a call that returns
neither — so it is presented as a choice and never slipped into the
connect flow; `GET /api/calendar/freebusy-check` lets
the settings screen tell "your grant is too narrow" (ask again) from
"Google is down" (do not).

**Degrade honestly.** Three ways to end up on gigs alone — the setting
is off, the scope was declined, Google was unreachable — and none may
be reported as if the calendar had been read. `basedOn` carries which,
and the page says so. Silently offering time the user cannot work is
the one outcome worse than no page at all.

Other decisions worth not rediscovering:

- **A token, not a slug.** `/a/andrey` is guessable and permanent. One
  active 128-bit token per user, stored only as a SHA-256 hash, so
  "regenerate" *is* the revoke. The cost, accepted: nothing can
  redisplay a link, so the share screen shows it once and says so.
- **Every failure answers 404** — unknown, revoked, expired alike. A
  401 would confirm a link had once been real, which tells the holder
  something about the user's relationship with them.
- **The public path never writes.** Elsewhere an unreadable or revoked
  Google token is healed by clearing it; here that would let a
  stranger's page load disconnect someone's calendar.
- **Times are the owner's, labelled.** A New York agency reading a
  London page on its own clock books an hour that does not exist. DST
  is handled by asking `Intl` for the instant the local clock reads
  09:00, never by adding nine hours to midnight.
- **Rate limiting is per isolate** and says so in its own comment. The
  real defence is that the token is unguessable and revocable.

### Phase 11 — Settings (2026-08-10)

One screen owning the knobs that were previously hardcoded, hidden, or
scattered. Storage is a single `settings_json` column on `users`
(migration 0009), not a column per setting: settings keep arriving, and a
blob with a zod schema and defaults makes adding one a code change rather
than a migration. Every read goes through `parseSettings()`, which fills
defaults, so a row written before a setting existed stays valid and NULL
means "all defaults". A blob that cannot be parsed degrades to defaults
per field rather than failing the request — losing a preference is not
worth refusing to load someone's gigs over.

The calendar sync and push nudges read the user's settings rather than
constants, which is the whole point: title prefix, reminder minutes (with
"use my calendar's own"), target calendar id, and both nudge thresholds.

Two repair operations live here rather than the dashboard, because they
are what you reach for when something looks wrong:
`POST /api/calendar/resync` clears the watermark so the next run
reconsiders every gig, and `POST /api/calendar/dedicated` creates a
"Gigsy" calendar, deleting old events from the calendar they actually
live on before switching.

**Theme is the one setting that does not sync.** It belongs to the device
and its surroundings — dark on a phone at a night shift, light on a
laptop in daylight — so it lives in `localStorage`. The palette is stored
as `R G B` channel triplets and consumed by Tailwind as
`rgb(var(--c-x) / <alpha-value>)`, so one `data-theme` attribute
re-themes every screen and the `/90` scrims keep their alpha. No `dark:`
utility exists in the codebase, by design.

## 14. Open items (carried from handoff)

- Exact UI flows/screens — needs design pass before Phase 3.
- ~~Notification strategy (reminders for unconfirmed leads / unpaid gigs).~~
  **Decided in Phase 7: no push in v1.** Two shipped mechanisms already cover
  it — confirmed gigs sync to Google Calendar (Phase 6), which fires the
  platform's own reminders, and the dashboard's "waiting to be paid"
  drill-down is the standing unpaid queue. Web Push is deferred, not
  rejected: iOS requires the PWA installed to the home screen plus a
  permission prompt, and it adds VAPID keys and subscription lifecycle —
  real cost for one user whose gigs are already on their calendar.
  **Revisited 2026-08-10 at the user's request: push is now scheduled as
  Phase 10.** The Phase 7 reasoning still holds for what it covered
  (calendar reminders handle *dated, confirmed* work); what it does not
  cover is the undated end — a lead that never gets confirmed and an
  invoice that never gets paid never reach a calendar.
- Whether `lead` gigs sync to calendar (default no).
- Fuzzy-match threshold for client names (avoid silent merges).
- Email Routing domain for per-user forwarding addresses.
- Where model choice lives long-term (global deployment config for now;
  per-user setting deferred). ~~Fallback behavior on provider errors /
  free-tier exhaustion.~~ **Decided in Phase 8:** `providerFromEnv`
  builds an ordered `FallbackProvider` chain from whichever API keys are
  configured — primary first, the other as backup — and the first
  provider to return an extraction wins. That is what the optional
  `ANTHROPIC_API_KEY` in §11 is for. Set it to arm the fallback; with
  one key configured the behaviour is unchanged.
