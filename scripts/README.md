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
| `python3 scripts/bump_versions.py` | Auto-bump versions of staged tiers (runs as the pre-commit hook) |
| `python3 -m unittest discover -s scripts` | Version-tooling test suite (also runs in CI) |

Tier classification is shared in `version_rules.py` — change rules
there, both the bumper and the CI gate follow.

## The bumper and your unstaged edits

`bump_versions.py` runs on every commit and rewrites a version field
in `webapp/package.json` / `backend/package.json`. It is required to
leave everything else alone:

* the **index** entry is rebuilt from the file's *staged* content, via
  `git update-index` — not `git add`, which would stage the worktree
  copy and drag unstaged edits into the commit;
* the **worktree** copy has only its version field edited in place, so
  unstaged edits (and line endings) survive byte-for-byte.

It once did neither — it wrote the bumped *staged* content over the
worktree file and `git add`-ed it, silently destroying any unstaged
edit to `package.json`. `test_version_scripts.py` guards both halves
(`PreservesUnstagedEdits`, `HookEndToEnd`, `LineEndingsPreserved`).

The root `package.json` is not a tier version file, so the bumper
never writes to it.

To check by hand that an unstaged edit survives a commit:

```sh
# 1. edit webapp/package.json (e.g. add a script) and do NOT stage it
# 2. stage something unrelated and commit
git add webapp/src/some-file.ts
git commit -m "unrelated change"
# 3. the edit is still there, unstaged, on top of the bumped version
git diff -- webapp/package.json
```

Step 3 must show your edit. If it shows nothing, the bump ate it —
`git checkout -p` the previous blob is not enough to recover, so treat
a failure here as a release blocker.

If the *version field itself* has an unstaged edit, the bumper cannot
reconcile the two and refuses to guess: it bumps the index, leaves the
worktree file untouched, and prints a warning telling you to
reconcile it by hand.

`setup-secrets.ps1` ships with placeholders. Copy it to
`setup-secrets.local.ps1` (gitignored), fill in the values there, and
run that copy — never commit real secrets.
