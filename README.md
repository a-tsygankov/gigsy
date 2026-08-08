# Gigsy

A personal tracker for one-off gig work (tasting stands, brand
ambassador shifts, promo work) across multiple agencies/clients.
Lightweight personal CRM + expense ledger with fast capture via email
forward or photo. See [`docs/plan.md`](docs/plan.md) for the full plan;
[`gigsy-handoff.md`](gigsy-handoff.md) for the original spec.

## Repo layout

```
gigsy/
├── backend/     Hono + Drizzle Worker (HTTP API, cron calendar sync, email capture)
├── webapp/      React + Vite PWA (deployed to Cloudflare Pages)
├── scripts/     Workstation deploy helpers + secrets bootstrap
└── docs/        Plan, phase plans
```

## Stack — pinned in [`docs/plan.md`](docs/plan.md) §2

- **Server:** Cloudflare Workers + Hono + Drizzle ORM on D1, R2 for
  receipt photos. Cron Triggers for calendar sync (Phase 6).
- **Web:** React 18 + Vite + TanStack Query + Tailwind, offline-first
  PWA (Dexie + outbox sync), deployed to Cloudflare Pages.
- **Auth:** Sign in with Google (Calendar scope in the same flow).
- **AI extraction:** Gemini Flash primary, provider swappable via
  `AI_PROVIDER`/`AI_MODEL` config.

## Getting started (Phase 0)

```bash
pnpm install
pnpm dev:backend          # in one terminal — wrangler dev (Miniflare)
pnpm dev:webapp           # in another     — vite dev (proxies /api → :8787)
```

## One-time provisioning

1. Create the Cloudflare resources and paste the D1 ID into
   [`backend/wrangler.toml`](backend/wrangler.toml):

   ```bash
   pwsh scripts/setup-secrets.ps1 -Provision
   ```

2. Fill in the placeholders at the top of
   [`scripts/setup-secrets.ps1`](scripts/setup-secrets.ps1) (work on an
   untracked copy: `scripts/setup-secrets.local.ps1`), then:

   ```bash
   pwsh scripts/setup-secrets.local.ps1 -All
   ```

   This sets the GitHub Actions secrets (`gh secret set`) and the
   Worker secrets (`wrangler secret put`). The full secret matrix is in
   [`docs/plan.md`](docs/plan.md) §11.

3. Apply migrations: `pnpm db:migrate:local` (dev) /
   `pnpm db:migrate:remote` (prod — CI also does this on deploy).

## CI/CD & versioning

Push to `main` auto-deploys backend (D1 migrations + Worker) and webapp
(Pages) via [`deploy.yml`](.github/workflows/deploy.yml), path-filtered
per package. PRs get a branch preview on Pages + Playwright E2E against
it.

Every tier (webapp, worker, schema) has its own version and it bumps
**automatically**: `pnpm install` installs a pre-commit hook
([`.githooks/pre-commit`](.githooks/pre-commit) →
[`scripts/bump_versions.py`](scripts/bump_versions.py)) that
patch-bumps whichever tiers the commit touches. Schema versions by
adding a new numbered migration.
[`version-check.yml`](.github/workflows/version-check.yml) is the CI
backstop for commits made without hooks.

## Hidden debug console

Tap the **Gigsy logo 3× quickly** inside the app to open the debug
console: tier versions (client/worker/schema + env), app settings, and
the client- and worker-side log feeds (`GET /api/version`,
`GET /api/debug/logs`).
