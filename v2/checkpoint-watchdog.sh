#!/usr/bin/env bash
# Keep checkpoint.json fresh (design 5.7b): writes it every
# RV2_CHECKPOINT_INTERVAL seconds and once more on EXIT. The trunk also calls
# checkpoint.sh directly after each verdict, so the on-disk checkpoint never
# lags by more than one assignment; the watchdog is the safety net for the idle
# stretches and for trunk death (the review job's tmux kill delivers SIGTERM,
# and the trap fires the final checkpoint).
#
# Runs in the background from boot-tmux.sh; the PID is recorded in
# $RV2_ORCH/watchdog.pid.
set -euo pipefail

V2_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=v2/lib.sh
. "$V2_DIR/lib.sh"

INTERVAL="${RV2_CHECKPOINT_INTERVAL:-300}"
mkdir -p "$(rv2_orch)"
echo "$$" >"$(rv2_orch)/watchdog.pid"

# One immediately so a run that dies in the first minutes still has a
# checkpoint, then trap EXIT for the final one.
"$V2_DIR/checkpoint.sh" || true

cleanup() {
  echo "watchdog: EXIT -> final checkpoint"
  "$V2_DIR/checkpoint.sh" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

while true; do
  sleep "$INTERVAL"
  "$V2_DIR/checkpoint.sh" 2>/dev/null || echo "watchdog: checkpoint failed; retrying next interval" >&2
done
