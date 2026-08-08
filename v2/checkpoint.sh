#!/usr/bin/env bash
# Checkpoint writer (design 5.7b) - a thin shim that delegates to the Node
# harness, which is the authority for the checkpoint contract
# (harness/checkpoint.mjs write):
#   {version:"v2-checkpoint.1", key:{pullNumber,headOid,enginePin}, runId,
#    writtenAt, ledger, completedAssignments}
# Completed assignments come from scanning evidence/ with contract validation
# (harness/evidence.mjs scanEvidence), so a shard is complete only when its
# evidence file is on disk AND valid. Called by the watchdog (every N min +
# trap exit) and by the trunk after each verdict; it never lags the disk state
# by more than one assignment.
#
# Usage: v2/checkpoint.sh
#   Env: RV2_ROOT (HARNESS_DIR), RV2_REPOSITORY, PR_NUMBER/HEAD_OID/ENGINE_PIN/
#   RUN_ID (or RV2_* equivalents). Writes <root>/checkpoint/checkpoint.json.
set -euo pipefail

V2_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=v2/lib.sh
. "$V2_DIR/lib.sh"

export HARNESS_DIR="$(rv2_root)"
export PR_NUMBER="${PR_NUMBER:-${RV2_PR_NUMBER:?RV2_PR_NUMBER required}}"
export HEAD_OID="${HEAD_OID:-${RV2_HEAD_OID:?RV2_HEAD_OID required}}"
export ENGINE_PIN="${ENGINE_PIN:-${RV2_ENGINE_PIN:?RV2_ENGINE_PIN required}}"
export RUN_ID="${RUN_ID:-${RV2_RUN_ID:-local-run}}"

result="$(node "$V2_DIR/../harness/checkpoint.mjs" write)"
if command -v jq >/dev/null 2>&1; then
  echo "checkpoint: $(printf '%s' "$result" | jq -c '{written, completed: (.completed|length)}')"
else
  echo "checkpoint: $result"
fi
