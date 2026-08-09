# Phase 5: Fast Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The handoff's signature flow (docs/plan.md §8): snap a flyer/receipt in-app or forward an email → AI extracts structured gig/expense fields → a **draft** the user reviews and confirms. Never auto-commits.

**Decisions:**
- **Drafts are server records** (migration 0003) — extraction runs server-side where the AI keys live. **Confirmation is client-side**: the review screen creates the gig/expense (+ client stub) through the normal offline-first path, then marks the draft confirmed. Confirming works offline; capturing requires a connection (extraction) — the deferred photo queue can change that later.
- **`ExtractionProvider` interface** with `gemini` (primary, `AI_PROVIDER`/`AI_MODEL` vars), `anthropic` (fallback/alt), and `stub` (**non-production only**, like test auth — canned extraction for dev/e2e without AI cost). All fetch injected; unit tests never hit real APIs.
- **Fuzzy client match** at extraction time, server-side (it has the clients list): normalize → exact, else bigram (Dice) similarity ≥ 0.6 → `matchedClientId`; below → `newClientName` for the user to confirm as a stub. Pure function, TDD'd — the threshold is the handoff's open item, now pinned and easy to tune.
- **Rate cap** (handoff open item): `AI_DAILY_CAP` var (default 50) — captures per user per UTC day, counted from drafts; 429 beyond.
- **Email capture**: `email()` handler (postal-mime) — recipient `u-<userId>@<domain>`, unknown user → reject. Raw email stored in R2 beside photo captures (`u/<uid>/captures/<draftId>`). **Inactive until a domain with Email Routing exists** (still-open item) — handler ships tested, wiring is dashboard-side.

**Draft shape** (`extracted_json`): `{ kind: "gig"|"expense"|"unknown", clientName?, matchedClientId?, matchConfidence?, location?, dateTimeMs?, amountOfferedCents?, amountCents?, category?, notes? }`

**Branch:** dev-7. No commits without the user's command.

---

### Task 1: Drafts entity

**Files:** `backend/migrations/0003_drafts.sql` (id, user_id, source email|photo, status pending|confirmed|discarded, raw_r2_key, extracted_json, timestamps; idx user+status), schema.ts, `src/repos/drafts.ts`, `src/routes/drafts.ts` (GET list ?status, GET /:id, PUT /:id {status} — only pending may transition, GET /:id/raw streams R2), tests

- [x] RED: list scoped+filtered; status transition rules (pending→confirmed/discarded ok; confirmed→anything 409); raw streaming + cross-user 404; 401s
- [x] GREEN; tests pass

### Task 2: Providers + matcher

**Files:** `src/capture/extraction.ts` (types + zod for ExtractedData), `src/capture/providers.ts` (Gemini/Anthropic/Stub + `providerFromEnv` — stub rejected in production), `src/capture/client-match.ts`, tests

- [x] RED matcher: exact-normalized match; bigram ≥0.6 matches ("Acme Staffing" ~ "ACME Staffing LLC"); distinct names don't silently merge; empty clients → new
- [x] RED providers: Gemini request shape (model in URL, inline_data image, JSON response parsed+validated; malformed JSON → null); Anthropic shape; stub returns canned gig; providerFromEnv gating
- [x] GREEN; tests pass

### Task 3: Capture endpoints

**Files:** `src/routes/capture.ts` (POST /api/capture/photo: cap check → R2 store → provider.extract → match → draft), `src/index.ts` email() handler + mounts, `package.json` +postal-mime, tests (direct email() invocation with crafted MIME)

- [x] RED photo: binary in → draft out with extraction+match applied; provider failure → 502 + no draft; over-cap → 429; 401
- [x] RED email: known `u-<userId>@…` → draft(source email, subject+body extracted); unknown user → setReject; raw stored
- [x] GREEN; tests pass

### Task 4: Webapp capture UI

**Files:** `src/lib/{types,api,data-service}.ts` (+Draft, capturePhoto, listDrafts, setDraftStatus, getDraftRawBlob), `src/screens/Capture.tsx` (camera-capture file input → upload → navigate to review), `src/screens/Drafts.tsx` (pending list), `src/screens/DraftReview.tsx` (photo preview, editable fields, match banner: "Matched: Acme (87%)" vs "New client: X", Confirm = local create client-stub→gig/expense + PUT status, Discard), Dashboard "📸 Capture" button + pending-drafts chip, routes

- [x] api unit tests for URLs/bearer; screens typecheck; offline banner on capture (needs connection)
- [x] GREEN; suite passes

### Task 5: E2E + verification

- [x] `.dev.vars` AI_PROVIDER=stub; e2e: sign in → capture a 1px png → review shows stub fields + new-client banner → Confirm → gig on /gigs list + draft gone from pending
- [x] Full sweep green; tree left uncommitted on dev-7
