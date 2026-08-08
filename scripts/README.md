# scripts/

Workstation helpers. CI auto-deploys on push to `main`
(see [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml)) — these are
for one-offs and one-time setup.

| Command | What it does |
| --- | --- |
| `./scripts/deploy.sh --backend` / `deploy.ps1 -Backend` | Apply D1 migrations + `wrangler deploy` |
| `./scripts/deploy.sh --webapp`  / `deploy.ps1 -Webapp` | Build + `wrangler pages deploy` |
| `./scripts/deploy.sh --all`     / `deploy.ps1 -All` | backend + webapp |
| `./scripts/setup-secrets.ps1 -Provision` | One-time: create D1 db + R2 bucket (paste the D1 ID into `backend/wrangler.toml`) |
| `./scripts/setup-secrets.ps1 -GitHub` | Set GitHub Actions secrets via `gh secret set` |
| `./scripts/setup-secrets.ps1 -Cloudflare` | Set Worker secrets via `wrangler secret put` |
| `./scripts/setup-secrets.ps1 -All` | GitHub + Cloudflare secrets in one go |
| `python3 scripts/check_version_bump.py` | The version-check CI gate, runnable locally (`BASE_REF=main`) |

`setup-secrets.ps1` ships with placeholders. Copy it to
`setup-secrets.local.ps1` (gitignored), fill in the values there, and
run that copy — never commit real secrets.
