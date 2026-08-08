#!/usr/bin/env bash
# Prepare the repo-under-review on the runner: a detached checkout at the PR
# head in $RV2_ROOT/repo, plus origin/main fetched for the diff. When the repo
# under review IS the harness repo (smoke trials), reuse the existing checkout
# via a worktree; otherwise clone fresh (blob:none to keep the clone fast).
set -euo pipefail

V2_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=v2/lib.sh
. "$V2_DIR/lib.sh"

repo="${RV2_REPOSITORY:?RV2_REPOSITORY required}"
head_oid="${RV2_HEAD_OID:?RV2_HEAD_OID required}"
ROOT="${RV2_ROOT:?RV2_ROOT required}"
TARGET="$ROOT/repo"
mkdir -p "$ROOT"
rm -rf "$TARGET"

if [ "$repo" = "${GITHUB_REPOSITORY:-}" ]; then
  [ -d "${GITHUB_WORKSPACE:-}/.git" ] || { echo "prepare-repo: harness workspace has no .git" >&2; exit 1; }
  git -C "$GITHUB_WORKSPACE" fetch origin "$head_oid" 2>/dev/null || true
  git -C "$GITHUB_WORKSPACE" worktree add --detach "$TARGET" "$head_oid" \
    || { echo "prepare-repo: worktree add failed" >&2; exit 1; }
else
  git clone --filter=blob:none --no-checkout "https://github.com/$repo.git" "$TARGET"
  git -C "$TARGET" fetch origin "$head_oid"
  git -C "$TARGET" checkout --detach "$head_oid"
fi

git -C "$TARGET" fetch --depth 200 origin "+refs/heads/main:refs/remotes/origin/main" 2>/dev/null || true
echo "prepare-repo: $TARGET at $(git -C "$TARGET" rev-parse --short HEAD)"
