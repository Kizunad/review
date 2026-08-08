#!/usr/bin/env bash
# Wait for the trunk to write review.json, up to RV2_REVIEW_TIMEOUT_S. On
# timeout, kill the session (SIGTERM fires the checkpoint trap) and exit 0 -
# the wrapper step turns the missing review.json into infrastructure_failure.
set -euo pipefail

V2_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=v2/lib.sh
. "$V2_DIR/lib.sh"

OUT="$(rv2_output)"
mkdir -p "$OUT"
REVIEW="$OUT/review.json"
TIMEOUT_S="${RV2_REVIEW_TIMEOUT_S:-1500}"
POLL_S="${RV2_REVIEW_POLL_S:-20}"

elapsed=0
while [ ! -f "$REVIEW" ]; do
  if [ "$elapsed" -ge "$TIMEOUT_S" ]; then
    echo "wait-review: timeout after ${elapsed}s - killing session; wrapper reports infrastructure_failure"
    tmux kill-session -t "$(rv2_session)" 2>/dev/null || true
    "$V2_DIR/checkpoint.sh" >/dev/null 2>&1 || true
    exit 0
  fi
  sleep "$POLL_S"
  elapsed=$((elapsed + POLL_S))
done

echo "wait-review: review.json present after ${elapsed}s"
tmux kill-session -t "$(rv2_session)" 2>/dev/null || true
exit 0
