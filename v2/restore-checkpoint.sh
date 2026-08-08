#!/usr/bin/env bash
# Restore a valid prior checkpoint for this exact PR + headOid + engine pin
# (design 5.7c). Downloads the rv2-p1 artifact of a prior run of this workflow
# at the same head, extracts checkpoint/checkpoint.json to
# $HARNESS_DIR/resume/checkpoint.json, and lets harness/checkpoint.mjs resume
# accept-or-reject it (structure + version + key checks all live in the Node
# module). On acceptance it writes resume/completed.txt + resume/resumed-from.txt;
# the trunk skips those shards.
#
# Best-effort by design: no gh, no prior runs, no artifact, or a rejected
# checkpoint are all normal "no resume" outcomes (exit 0). P1 resume is a
# cost-saving optimization, never a review blocker.
set -euo pipefail

V2_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=v2/lib.sh
. "$V2_DIR/lib.sh"

ROOT="$(rv2_root)"
repo="${RV2_REPOSITORY:?RV2_REPOSITORY required}"
pr="$(rv2_pr_number)"
head_oid="$(rv2_head_oid)"
engine_pin="$(rv2_engine_pin)"
[ -n "$pr" ] && [ -n "$head_oid" ] && [ -n "$engine_pin" ] || {
  echo "restore: PR_NUMBER, HEAD_OID, ENGINE_PIN required" >&2; exit 64; }
workflow_file="${RV2_WORKFLOW_FILE:-review-v2-p1.yml}"

export HARNESS_DIR="$ROOT"
export PR_NUMBER="$pr"
export HEAD_OID="$head_oid"
export ENGINE_PIN="$engine_pin"
export RUN_ID="$(rv2_run_id)"
mkdir -p "$ROOT/resume"

node_resume() {
  node "$V2_DIR/../harness/checkpoint.mjs" resume
}

command -v gh >/dev/null 2>&1 || { echo "restore: gh not installed; no resume"; node_resume >/dev/null 2>&1 || true; exit 0; }

wf_id="$(gh api "repos/$repo/actions/workflows" --jq ".workflows[] | select(.path==\"$workflow_file\") | .id" 2>/dev/null || echo "")"
[ -n "$wf_id" ] || { echo "restore: workflow $workflow_file not found in $repo; no resume"; node_resume >/dev/null 2>&1 || true; exit 0; }

# Prior runs of THIS workflow, newest first. A run that timed out (and thus
# produced the checkpoint we want) may be recorded as failure, so filter by
# head sha only, not conclusion.
runs="$(gh api "repos/$repo/actions/workflows/$wf_id/runs?per_page=50" \
  --jq ".workflow_runs[] | select(.head_sha==\"$head_oid\") | .id" 2>/dev/null || echo "")"
[ -n "$runs" ] || { echo "restore: no prior runs at $head_oid; no resume"; node_resume >/dev/null 2>&1 || true; exit 0; }

for run_id in $runs; do
  art_ids="$(gh api "repos/$repo/actions/runs/$run_id/artifacts" \
    --jq '.artifacts[] | select(.name=="rv2-p1") | .id' 2>/dev/null || echo "")"
  [ -n "$art_ids" ] || continue
  art_id="$(printf '%s\n' "$art_ids" | head -1)"

  tmp="$(mktemp -d)"
  echo "restore: downloading rv2-p1 artifact $art_id from run $run_id"
  gh api "repos/$repo/actions/artifacts/$art_id/zip" >"$tmp/checkpoint.zip" 2>/dev/null || { rm -rf "$tmp"; continue; }
  (cd "$tmp" && unzip -o -q checkpoint.zip) || { rm -rf "$tmp"; continue; }
  # The artifact is the whole HARNESS_DIR; the checkpoint nests at checkpoint/.
  if [ -f "$tmp/checkpoint/checkpoint.json" ]; then
    cp "$tmp/checkpoint/checkpoint.json" "$ROOT/resume/checkpoint.json"
    rm -rf "$tmp"
    echo "restore: candidate placed at resume/checkpoint.json; accepting via Node resume"
    node_resume
    exit 0
  fi
  rm -rf "$tmp"
done

echo "restore: no rv2-p1 artifact with a checkpoint found for PR $pr at $head_oid"
node_resume >/dev/null 2>&1 || true
exit 0
