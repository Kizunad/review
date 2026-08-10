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
head_oid="$(rv2_head_oid)"
[ -n "$head_oid" ] || { echo "prepare-repo: HEAD_OID / RV2_HEAD_OID required" >&2; exit 64; }
ROOT="${RV2_ROOT:?RV2_ROOT required}"
TARGET="$ROOT/repo"
mkdir -p "$ROOT"
rm -rf "$TARGET"

# ASK THE CHECKOUT, DO NOT ASK THE RUN CONTEXT.
#
# This used to be `[ "$repo" = "$GITHUB_REPOSITORY" ]`, a proxy for "the workspace already holds
# the repo under review". Commit 689c2f4 made the workspace hold the ENGINE under workflow_call
# and left the proxy alone, which broke the proxy in exactly one mode - the shipped one:
# Bong calls with repository=Kizunad/Bong, GITHUB_REPOSITORY inside a reusable workflow is the
# CALLER (Kizunad/Bong), the two compare equal, and we would try to `git worktree add` a Bong
# commit inside a checkout of Kizunad/review. The fetch failure is swallowed by `|| true`, so it
# surfaces as "invalid reference" from worktree add, at step 7, with no anchors, no policy hash,
# no artifact - infrastructure_failure on every Bong PR, while every dispatch trial against the
# engine's own repo stayed green because there the proxy is accidentally true.
#
# The property actually wanted is "can this workspace produce the commit under review". That is
# not something to infer from two name strings; it is one command. So the reuse path is taken
# only when the commit is genuinely resolvable in the workspace, and anything else clones - the
# slow, always-correct branch, which is the right default for a fast path that is an optimisation.
reuse=0
if [ -d "${GITHUB_WORKSPACE:-}/.git" ]; then
  git -C "$GITHUB_WORKSPACE" fetch origin "$head_oid" 2>/dev/null || true
  # ^{commit} so an annotated tag or a tree with this name cannot pass for the commit.
  if git -C "$GITHUB_WORKSPACE" rev-parse --verify --quiet "$head_oid^{commit}" >/dev/null; then
    reuse=1
  fi
fi

if [ "$reuse" = 1 ]; then
  git -C "$GITHUB_WORKSPACE" worktree add --detach "$TARGET" "$head_oid" \
    || { echo "prepare-repo: worktree add failed" >&2; exit 1; }
  echo "prepare-repo: reusing the workspace checkout (it already has $head_oid)"
else
  git clone --filter=blob:none --no-checkout "https://github.com/$repo.git" "$TARGET"
  git -C "$TARGET" fetch origin "$head_oid"
  git -C "$TARGET" checkout --detach "$head_oid"
fi

git -C "$TARGET" fetch --depth 200 origin "+refs/heads/main:refs/remotes/origin/main" 2>/dev/null || true
echo "prepare-repo: $TARGET at $(git -C "$TARGET" rev-parse --short HEAD)"
