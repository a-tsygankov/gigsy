# Phase 3: Webapp Core (Online) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A signed-in, usable app (docs/plan.md §13 Phase 3): Google login, gig/client/expense list + edit screens, online-first against the Phase 1/2 API. Offline sync is Phase 4 — this phase establishes the screens and data layer it will slot into.

**Architecture:** Injected `ApiClient` (fetch wrapper: bearer header, 401 → one refresh → retry) + `AuthManager` (access token in memory, refresh token in IndexedDB via an injectable KV interface — iOS PWA cookie persistence is unreliable, docs/plan.md §6). React Router routes behind an `AuthGate`; TanStack Query per entity. Google Identity Services delivers the ID token; the public `GET /api/auth/config` endpoint supplies the client ID so it lives once, in wrangler.toml vars.

**Branch:** dev-3. No commits without the user's command.

---

## Design spec (the handoff's open "UI flows" item — decided here)

**Visual language** (per frontend-design rules — one accent, one radius, one spacing scale):

- Light minimalism on slate: bg `slate-50`, surfaces white, text `slate-900/600/400`.
- **Accent: emerald-600** (money/work) — primary buttons, active tab, FAB.
- Status pills: lead `slate`, confirmed `sky`, completed `amber`, paid `emerald`.
- Radius **12px** (`rounded-xl`) everywhere; Tailwind spacing scale; system font stack (no webfont — PWA start-up wins); transitions ≤200ms; every interactive element gets hover + focus-visible; every list gets a loading skeleton and an empty state with a call-to-action.

**Navigation:**

```
/login                    Centered card: wordmark, blurb, [Sign in with Google]
/        (Gigs tab)       Header [Gigsy logo·3-tap console] ── list ── FAB +
/gigs/new, /gigs/:id      Form screen (client, status, date/time, location, $offered, $paid, notes) + Delete
/clients, /clients/:id    List + form (name, contact, notes)
/expenses, /expenses/:id  List + form ($amount, category, linked gig, notes)
```

Bottom tab bar (Gigs · Clients · Expenses), visible only when authed; Reports joins in Phase 7. Gig cards show: client name (or "—"), date, location, status pill, `paid ?? offered` money line. Money entered in dollars, stored in cents (`parseMoney`).

**Auth flow:** GIS button → `credential` (ID token) → `POST /api/auth/google` → store session. Calendar consent (auth-code flow) is deliberately NOT part of login — it becomes a "Connect calendar" action in Phase 6, matching the backend's optional `authCode`.

---

### Task 1: Backend `GET /api/auth/config` (public)

**Files:** `backend/src/routes/auth.ts` (+route), `backend/test/auth-routes.test.ts` (+cases)

- [x] RED: returns `{googleClientId}` from vars; no auth required
- [x] GREEN; tests pass

### Task 2: Webapp data layer (TDD, injectable I/O)

**Files:** `src/lib/money.ts` (+test), `src/lib/api.ts` (+test), `src/lib/auth-store.ts` (+test), `src/lib/google-signin.ts` (browser-only GIS loader, thin)

- [x] RED money: `parseMoney("123.45")→12345`, `"1,234.5"→123450`? No — reject junk, accept `"123"`, `"123.4"`, `"123.45"`, strip `$`/commas; null on invalid
- [x] RED api: adds bearer header; JSON in/out; on 401 calls refresh once then retries; refresh failure → session-expired signal; typed entity methods (list/get/put/delete per entity, reports)
- [x] RED auth-store: `bootstrap()` restores session from storage (refresh flow); `signIn(idToken)` stores session; `signOut()` clears; access-token expiry tracked; storage injected (in-memory in tests, Dexie KV in app)
- [x] GREEN all; tests pass

### Task 3: App shell

**Files:** `src/main.tsx` (router), `src/App.tsx` → routes, `src/components/{AuthGate,TabBar,Header,Fab,StatusPill,Skeleton,EmptyState}.tsx`, `src/screens/Login.tsx`, contexts for ApiClient/Auth

- [x] Login screen (config-driven GIS; unconfigured → explanatory state)
- [x] AuthGate redirect, tab bar, header with 3-tap console logo preserved
- [x] Typecheck green

### Task 4: Entity screens

**Files:** `src/screens/{Gigs,GigEdit,Clients,ClientEdit,Expenses,ExpenseEdit}.tsx`

- [x] Lists: skeleton → cards → empty state; FAB; status pills; money lines
- [x] Forms: controlled inputs, client/gig selects fed by queries, save (PUT upsert w/ crypto.randomUUID for new), delete with confirm
- [x] Typecheck green

### Task 5: E2E + verification

**Files:** `webapp/e2e/{smoke,hidden-console,auth}.spec.ts` updates

- [x] Unauthed visit → redirected to /login; Google button (or unconfigured notice) visible; tab bar absent
- [x] Hidden console still opens from the header logo pre-login
- [x] `pnpm -r typecheck && pnpm -r test && pnpm -r build` + e2e against local dev green; tree left uncommitted on dev-3
