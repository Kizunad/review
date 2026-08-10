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

# RESUME IS OFF, DELIBERATELY, AND THIS IS THE STATED REASON RATHER THAN AN ACCIDENT.
#
# It had been off by accident twice over, which is how it was found: the selector matched the
# artifact name exactly (`=="rv2-p1"`) while the upload became rv2-p1-<run_id>-<run_attempt>,
# and the workflow step sets no GH_TOKEN, so every `gh api` here fell through its `|| echo ""`
# into "no resume". Silent dead code that reported a normal outcome. The selector is fixed
# above so that turning this on is a one-line decision rather than a debugging session.
#
# But an independent review of the self-approval design showed that REPAIRING resume opens an
# approve path, so it must not come back by default:
#
#   1. shard-diff.sh derives assignment ids POSITIONALLY from the PR's own diff, so the pull
#      request knows every id before the run starts;
#   2. the crew is REQUIRED to write evidence/<id>.json, and completion is tested by existence
#      (`rv2_assignment_complete` is `[ -f ... ]`);
#   3. so a test in the PR pre-writes evidence for every shard, checkpoint.sh faithfully records
#      them all as completedAssignments, and that checkpoint is uploaded;
#   4. the next run at the same head restores it - the key {pullNumber, headOid, enginePin} is
#      entirely attacker-known and matches - the trunk skips every assignment, dispatches
#      nothing, finds nothing, and `approve` is satisfied VACUOUSLY, because approve requires
#      zero failures and all findings minor, which zero findings meets by construction.
#
# The fix is not here. It is a deterministic precondition on the privileged side: a resumed
# assignment must be backed by a DISPATCHED ledger row in the checkpointed ledger snapshot, not
# by the existence of an evidence file the reviewed code was invited to write. Until that
# exists, resume stays off, and the saving it buys is not worth an approve nobody reviewed.
if [ "${RV2_ALLOW_RESUME:-0}" != "1" ]; then
  echo "restore: resume is DISABLED (RV2_ALLOW_RESUME != 1) - checkpoint poisoning is unfixed."
  echo "restore: see the comment in v2/restore-checkpoint.sh; this is a decision, not a failure."
  exit 0
fi

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
    --jq '.artifacts[] | select(.name | startswith("rv2-p1")) | .id' 2>/dev/null || echo "")"
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
