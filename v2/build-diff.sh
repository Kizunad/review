#!/usr/bin/env bash
# Build the PR diff deterministically into $RV2_ROOT/diff.txt: the changes
# between the PR base (origin/main) and the head. The trunk shards this file
# (shard-diff.sh) - the split rules live in one place and are shared with the
# engine's own sharder.
set -euo pipefail

V2_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=v2/lib.sh
. "$V2_DIR/lib.sh"

REPO_DIR="$RV2_ROOT/repo"
head_oid="${RV2_HEAD_OID:?RV2_HEAD_OID required}"
[ -d "$REPO_DIR/.git" ] || { echo "build-diff: $REPO_DIR is not a git checkout" >&2; exit 1; }

if ! git -C "$REPO_DIR" cat-file -e "$head_oid^{commit}" 2>/dev/null; then
  echo "build-diff: head $head_oid not present; fetching" >&2
  git -C "$REPO_DIR" fetch origin "$head_oid"
fi

if git -C "$REPO_DIR" cat-file -e refs/remotes/origin/main 2>/dev/null; then
  base="$(git -C "$REPO_DIR" merge-base origin/main "$head_oid" 2>/dev/null || git -C "$REPO_DIR" rev-parse origin/main)"
else
  echo "build-diff: origin/main not present; diffing against empty tree" >&2
  base="$(git -C "$REPO_DIR" hash-object -t tree /dev/null)"
fi

git -C "$REPO_DIR" diff "$base" "$head_oid" >"$RV2_ROOT/diff.txt"
echo "build-diff: $(wc -c <"$RV2_ROOT/diff.txt") bytes, base=$(git -C "$REPO_DIR" rev-parse --short "$base")"
