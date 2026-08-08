# Gigsy — Project Handoff

## What it is
A personal tracker for people doing one-off gigs (tasting stands, brand ambassador work, promo shifts, etc.) across multiple agencies/clients. Solo-user-per-account app: each user manages their own gigs, calendar, expenses, and notes. Not a staffing marketplace — no cross-user visibility, no admin/agency role.

## Core problem it solves
Existing tools don't fit this niche:
- Rideshare/delivery expense trackers (Hurdlr, Everlance, Gridwise) are mileage-first and have no "offered vs. paid" pipeline concept.
- Agency staffing platforms (Ubeya, Outfield, Liveforce) are built for the company booking workers, not the worker tracking their own scattered gigs.

Gigsy is a lightweight personal CRM + expense ledger for gig work, with fast capture via email forward or photo.

## Stack
Same as the developer's existing FC26 Team Picker project — reuse patterns, not necessarily code:
- **Frontend:** React + TypeScript, PWA (installable, offline-capable)
- **Backend:** Hono on Cloudflare Workers
- **DB:** Cloudflare D1
- **Object storage:** Cloudflare R2 (receipt/gig photos)
- **Auth:** Sign in with Google (also grants Calendar API scope in the same flow)
- **AI extraction:** Gemini Flash (free tier) as the primary model for parsing forwarded emails and photos into draft gig/expense records. Model choice configurable per-deployment (env var / config, not hardcoded) so it can be swapped for Claude or another provider later without touching the extraction pipeline's call sites.
- Note: Durable Objects deliberately **not** used here — that pattern is for FC26's multi-user realtime room sync; Gigsy has no realtime multi-user coordination need.

## Data model (D1)

```
users
  id, email, google_refresh_token_enc, created_at, modified_at

clients
  id, user_id, name, contact_info, notes, created_at, modified_at

gigs
  id, user_id, client_id (nullable, FK -> clients.id), status (lead|confirmed|completed|paid),
  location, date_time, calendar_event_id,
  amount_offered, amount_paid, notes, source, created_at, modified_at

expenses
  id, user_id, gig_id (nullable), amount, category,
  receipt_r2_key, notes, created_at, modified_at
```

`modified_at` is set on every insert (same as `created_at`) and bumped on every update — needed for conflict resolution on the offline sync path (last-write-wins by `modified_at`, or at minimum a signal for the client to detect it has a stale local copy after reconnect).

`clients` represents the agencies/companies/individuals a user works gigs for. Replaces the earlier free-text `client` field on `gigs` — normalizing this avoids duplicate/misspelled client names and enables clean per-client reporting. Scoped by `user_id` like everything else (one user's client list is private to them, not shared even if two users happen to work for the same agency).

Every query scoped by `WHERE user_id = ?` pulled from the verified JWT claim — this is the entire multi-tenancy boundary. Never trust a client-supplied user ID.

## Auth flow
1. Client obtains Google ID token (Sign in with Google), requesting Calendar scope alongside basic profile/email.
2. Worker verifies the ID token, upserts the `users` row, issues its own short-lived JWT + refresh token.
3. Refresh token stored in IndexedDB client-side (not cookies — unreliable persistence in iOS PWAs).
4. JWT sent as `Authorization: Bearer` on every API call; Hono JWT middleware verifies and extracts `user_id`.
5. Google refresh token stored server-side per user, **encrypted at rest** (AES via a Workers Secret key) — used later for Calendar sync jobs.

## Offline-first design
The phone is the database; the Worker/D1 is the backup and multi-device sync point.

- **IndexedDB (Dexie) is the source of truth on-device.** All reads/writes hit local storage first; UI never blocks on network.
- **Outbox queue pattern.** Every mutation (new gig, expense, note edit) also appends to a local `pending_ops` table: client-generated UUID, op type, payload.
- **Sync worker** drains the outbox on `online` event + periodic retry w/ backoff, POSTing to Hono endpoints.
- **Idempotency via client UUID.** Worker upserts by that ID so retries/dupes from flaky connections don't create duplicate records.
- **Photo/receipt uploads queued separately** from metadata sync (stored locally first — IndexedDB or Origin Private File System for larger files) so a slow image upload never blocks gig data from syncing.
- **Service worker caches the app shell** (Workbox or hand-rolled) so the PWA itself loads with zero connectivity, not just the data layer.
- Per-user namespacing: outbox entries and local Dexie instances carry `user_id`, preventing cross-account writes if the app is ever used on a shared device.

## Calendar integration
- Google Calendar API, per-user, using each user's stored refresh token.
- Sync triggered on reconnect and/or a cron'd Worker; iterates users with pending calendar-relevant changes (new/updated confirmed gigs → calendar events).
- `calendar_event_id` stored on the gig row to support update/delete round-trips.

## Fast capture (email + photo)
- Dedicated per-user forwarding address; **Cloudflare Email Workers** receives mail directly (no third-party inbound-parsing service needed).
- Email body + attachments (or a photo taken in-app, e.g. a flyer or receipt) sent to the Claude API to extract structured gig/expense fields.
- Result surfaces as a **draft record** for the user to review/confirm — never auto-commits extracted data.
- Extracted client name is matched against the user's existing `clients` table (fuzzy match on name); if no match, the draft includes a new client stub for the user to confirm alongside the gig.

## Reports
No separate reporting engine needed — reports are filtered/grouped SQL queries over `gigs`/`expenses`:
- By month, by client
- Offered vs. paid variance
- Net income after expenses

## Naming
Decided: **Gigsy**

## Open items / not yet decided
- Exact UI flows/screens (gig list, gig detail, capture flow, reports view) — not yet designed
- Notification strategy (e.g. reminders for unconfirmed leads, unpaid completed gigs)
- Whether "lead" status gigs should sync to calendar at all, or only confirmed+
- Rate limiting / cost control on Claude API calls for email/photo extraction
- Backup/export (e.g. CSV export of gigs+expenses)
- Client name fuzzy-matching threshold/logic for the capture flow (avoid silent merges of distinct clients)
- Where the Gemini/Claude model choice lives (per-user setting vs. global deployment config) and how fallback behaves if the configured provider errors or free-tier limits are hit
