# Handoff: showing Gigsy feedback in gigsy-analytics

Date: 2026-10-11
From: gigsy (`a-tsygankov/gigsy`), branch `feat/feedback` (merging as the
"Send feedback" feature; design in
`docs/superpowers/specs/2026-10-11-feedback-design.md`)
To: gigsy-analytics — a new project on the same stack

## What gigsy-analytics must do

Show every piece of feedback users have sent from inside Gigsy, split
into **new** (not yet looked at by an admin) and **old** (looked at),
with the message, who sent it, when, from which screen, which client
version, and the attached images. Marking feedback as looked at is
gigsy-analytics' job; Gigsy itself never reads feedback back.

## Where the data is

Gigsy stores feedback **server-side, before any email is sent**, in two
places it already owns:

| What | Where | Access |
|---|---|---|
| The record | D1 database `gigsy-db` (id `c835bca1-4691-4651-8ac1-91de4d6ca458`), table `feedback` | Bind the same database in gigsy-analytics' `wrangler.toml` (`[[d1_databases]] binding = "GIGSY_DB"`, same `database_id`). D1 allows several Workers on one account to bind one database. |
| The images | R2 bucket `gigsy-receipts`, keys `u/<userId>/feedback/<feedbackId>/<n>` | Bind the same bucket (`[[r2_buckets]] binding = "GIGSY_RECEIPTS"`). Serve images through your own authenticated route; never expose bucket keys to a browser directly. |

Both bindings are account-level configuration, no secrets to share.
Treat the Gigsy database as **read-only from gigsy-analytics**: Gigsy's
migrations own that schema, and Gigsy's CI applies them. Do not add
columns to `feedback`; keep gigsy-analytics' own state in its own D1
(below).

### The `feedback` table (migration `0021_feedback.sql` in gigsy)

```sql
CREATE TABLE feedback (
  id            TEXT PRIMARY KEY,          -- UUID
  user_id       TEXT NOT NULL REFERENCES users(id),
  user_email    TEXT NOT NULL,             -- copied at send time, so no join needed
  message       TEXT NOT NULL,             -- 1..4000 chars, trimmed
  page          TEXT,                      -- route the user was on, e.g. "/gigs/123"
  client_version TEXT,                     -- webapp version, e.g. "0.0.190"
  user_agent    TEXT,
  images_json   TEXT NOT NULL DEFAULT '[]',-- see below
  email_status  TEXT NOT NULL,             -- 'sent' | 'unsent' | 'failed'
  email_error   TEXT,                      -- the sender's message when 'failed'
  created_at    INTEGER NOT NULL           -- epoch ms
);
CREATE INDEX idx_feedback_user_created ON feedback(user_id, created_at);
```

`images_json` is a JSON array, one entry per attached image, in the
order the user attached them:

```json
[{ "key": "u/<userId>/feedback/<feedbackId>/0",
   "type": "image/jpeg", "size": 182331, "name": "IMG_0412.jpeg" }]
```

Limits enforced by Gigsy: at most 5 images, each ≤ 8 MB, ≤ 20 MB
together; 20 submissions per user per UTC day.

`email_status` tells you whether the admins were also mailed. `unsent`
means Gigsy had no sending domain / sender address / admin list
configured at the time — those rows are exactly the ones nobody has
seen by email, so they matter most to this screen.

**Verify the DDL against the migration file when the branch merges**;
this document was written from the design spec before the file landed.

## "New" vs "old": gigsy-analytics owns the marker

Gigsy records no review state and must not be asked to. Keep it in
gigsy-analytics' own D1:

```sql
CREATE TABLE feedback_reviews (
  feedback_id TEXT PRIMARY KEY,   -- feedback.id in gigsy-db
  reviewed_by TEXT NOT NULL,      -- admin email
  reviewed_at INTEGER NOT NULL
);
```

A feedback row is **new** when it has no `feedback_reviews` row, **old**
otherwise. Two queries (two databases cannot be joined in D1): list from
`gigsy-db` ordered by `created_at DESC`, then look the ids up in your own
table. An admin action "Mark as reviewed" inserts the row; "Mark as new"
deletes it.

## Suggested API in gigsy-analytics

All behind the admin sign-in gigsy-analytics already has (Google
sign-in, allow-listed to the admin addresses — the same list Gigsy keeps
in its `ADMIN_EMAILS` secret: `tsygankov@gmail.com`,
`gigsy.test@gmail.com`).

| Route | Does |
|---|---|
| `GET /api/feedback?state=new\|old\|all&before=<ms>&limit=50` | Page of feedback, newest first, each with `reviewed` and the image list (ids only, not keys). |
| `GET /api/feedback/:id/images/:n` | Streams image `n` from R2 with its stored content type. Checks the id exists in `feedback` first, so a bucket key can never be guessed through this route. |
| `POST /api/feedback/:id/reviewed` / `DELETE …/reviewed` | Mark as old / new. |

## Suggested UI

One screen: a list of cards (user email, relative time, page, version,
first line of the message, thumbnails), a `New / Old / All` segmented
control defaulting to New, a count badge of new items in the nav. Tap a
card for the full message, the images at size, the user agent, and the
`email_status` with its error when failed. "Mark as reviewed" on the
card and on the detail.

## Stack — the same as Gigsy, deliberately

Use the same shape so the two repositories read alike:

- **Worker**: TypeScript, Hono 4, drizzle-orm on D1, zod validation,
  `@cloudflare/vitest-pool-workers` for tests, wrangler 4.
- **Web**: React 18 + Vite 5, TypeScript, Tailwind 3 with the Gigsy
  design-system components (copy `webapp/src/components` and
  `webapp/src/styles/tokens`; see `docs/design-system.md`), TanStack
  Query, react-router 6, vitest + jsdom for units, Playwright for e2e.
- **CI**: the same `deploy.yml` shape — PR runs tests + preview deploy,
  merge to main deploys; `scripts/bump_versions.py` style patch-version
  bumps per tier.
- **Auth**: Gigsy's Google sign-in + allowlist (`backend/src/auth/*`,
  `backend/src/middleware/auth.ts`) can be lifted as-is; the allowlist
  here IS the admin list.

## Things to get right

- **Read, never write, gigsy-db.** No migrations against it from this
  project, no `UPDATE feedback`. Gigsy's own `db:migrate:remote` step
  will not know about anything you add, and the two schemas would drift.
- **Images are private data** (screenshots of someone's gigs and
  money). Serve them only behind the admin session, with
  `Cache-Control: private`.
- **Paging by `created_at`, not offset**: rows arrive constantly and
  offset pages skip or repeat.
- **`user_id` is a Gigsy user id**, useful only for grouping "same
  person"; `user_email` is what to display.
- The daily cap and size limits are Gigsy's; do not re-validate on
  read, do display `size` so an admin knows what they are opening.

## Checklist for the first PR in gigsy-analytics

- [ ] Bind `gigsy-db` and `gigsy-receipts` in `wrangler.toml`.
- [ ] Own D1 with `feedback_reviews`.
- [ ] The three routes above, with tests against a seeded `feedback`
      table (copy the DDL into the test migration list).
- [ ] The list screen with New/Old/All and the new-count badge.
- [ ] An e2e that seeds one feedback row with one image, sees it under
      New, marks it reviewed, sees it under Old.
