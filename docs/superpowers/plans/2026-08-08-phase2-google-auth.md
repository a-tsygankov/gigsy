# Phase 2: Google Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Real sign-in (docs/plan.md §6): Google ID-token verification → user upsert → worker-issued JWT + rotating opaque refresh token; Google refresh token stored AES-GCM-encrypted for Phase 6 calendar sync; `/api/debug/*` moved behind JWT.

**Architecture:** `POST /api/auth/google` verifies the Google ID token against Google's JWKS (RS256), upserts `users` by email, optionally exchanges the one-time auth code for a Google refresh token (encrypted at rest with `REFRESH_TOKEN_ENC_KEY`), and returns `{accessToken, refreshToken}`. `POST /api/auth/refresh` rotates the opaque refresh token (stored only as a SHA-256 hash in the new `refresh_tokens` table). External I/O (JWKS fetch, token-endpoint fetch) is injected so the whole flow tests offline against a self-generated RSA keypair.

**Tech Stack:** hono/jwt (RS256 verify with JWK key input), WebCrypto (AES-GCM, SHA-256, RSA test keys), Drizzle/D1.

**Branch:** dev-2 (stacked on dev-1). No commits without the user's command.

---

### Task 1: AES-GCM crypto (`src/auth/crypto.ts`)

- [x] RED (`test/crypto.test.ts`): encrypt→decrypt round-trip; decrypt with wrong key → null; tampered ciphertext → null; two encryptions of the same plaintext differ (random IV)
- [x] GREEN: `encryptString(plain, base64Key)` → base64(iv‖ciphertext); `decryptString(blob, base64Key)` → string | null. AES-GCM 256, 12-byte IV
- [x] Tests pass

### Task 2: Users repo + refresh-token store + migration

**Files:** `migrations/0001_refresh_tokens.sql`, `src/db/schema.ts` (+refreshTokens), `src/repos/users.ts`, `src/auth/refresh-store.ts`, `test/users-repo.test.ts`, `test/refresh-store.test.ts`, test helper applies both migrations

```sql
CREATE TABLE refresh_tokens (
  token_hash TEXT PRIMARY KEY,      -- SHA-256; raw token never stored
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);
```

- [x] RED users: `upsertByEmail` creates (UUID id) once, second call returns same id; `setGoogleRefreshTokenEnc` persists + bumps modified_at
- [x] RED store: `issue(userId)` returns raw token; `consume(raw)` → userId and **deletes** (second consume → null); expired → null; unknown → null
- [x] GREEN both; tests pass

### Task 3: Google verification + code exchange (`src/auth/google.ts`)

- [x] RED (`test/google.test.ts`): self-generated RSA keypair exported as JWKS via injected fetcher; valid ID token → `{email, sub}`; wrong aud / bad iss / expired / unknown kid → null. `exchangeAuthCode` with stubbed fetch: ok → `{refreshToken}`; non-ok → null
- [x] GREEN: `verifyGoogleIdToken({idToken, clientId, fetchJwks})` — decode header kid, match JWK, `hono/jwt verify(token, jwk, "RS256")`, then iss/aud/email checks; `exchangeAuthCode({code, clientId, clientSecret, redirectUri, fetchFn})` → POST oauth2.googleapis.com/token
- [x] Tests pass

### Task 4: Auth routes + debug behind JWT

**Files:** `src/routes/auth.ts` (factory `makeAuthRouter(deps)` for DI), `src/index.ts` (mount default deps), `src/routes/debug.ts` (+requireAuth), `test/auth-routes.test.ts`, update `test/version-debug-routes.test.ts`

- [x] RED routes: google login issues tokens that pass requireAuth; same email twice → same user id; login with authCode stores decryptable `google_refresh_token_enc`; invalid ID token → 401; refresh rotates (old token dead, new works); garbage refresh → 401
- [x] RED debug: `/api/debug/logs` 401 unauth, 200 with token (`/api/version` stays public — the hidden console must show versions before login)
- [x] GREEN; tests pass

### Task 5: Verification

- [x] `pnpm -r typecheck && pnpm -r test && pnpm -r build` + python suite green; tree left uncommitted on dev-2; version bumps left to the pre-commit hook (worker + new migration = schema bump by file)
