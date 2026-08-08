#!/usr/bin/env bash
# Workstation deploy helper. CI handles main-branch deploys; this is
# for one-offs ("deploy backend before merging").
#
# Usage:
#   ./scripts/deploy.sh --backend
#   ./scripts/deploy.sh --webapp
#   ./scripts/deploy.sh --all
set -euo pipefail
cd "$(dirname "$0")/.."

do_backend=0; do_webapp=0
[[ $# -eq 0 ]] && { echo "usage: $0 [--backend] [--webapp] [--all]"; exit 1; }
for arg in "$@"; do
  case "$arg" in
    --backend)  do_backend=1 ;;
    --webapp)   do_webapp=1 ;;
    --all)      do_backend=1; do_webapp=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 1 ;;
  esac
done

if [[ $do_backend -eq 1 ]]; then
  echo "── backend ──"
  pnpm --filter gigsy-backend db:migrate:remote
  pnpm --filter gigsy-backend deploy
fi
if [[ $do_webapp -eq 1 ]]; then
  echo "── webapp ──"
  pnpm --filter gigsy-webapp build
  pnpm --filter gigsy-webapp deploy
fi
