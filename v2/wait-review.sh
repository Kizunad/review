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

# Consecutive dead polls before believing the trunk is gone. A single miss is not proof:
# rv2_alive looks for a claude/pi/node child of the pane, and there is a real gap between
# one command exiting and the next starting.
DEAD_LIMIT="${RV2_TRUNK_DEAD_POLLS:-3}"

# Capture the panes, THEN kill. Order matters: kill-session destroys the only copy of what
# the trunk and workers printed. Trial 4 boots cleanly, ran to the wrapper, and produced
# decision=infrastructure_failure with "trunk produced no review.json" - and its artifact had
# no logs, no evidence, no ledger, no directives, because the trunk died after boot and the
# session was killed with nothing read out of it. The boot path already dumps panes; this is
# the same failure one step later, and it was invisible for the same reason.
give_up() {
  echo "wait-review: $1"
  rv2_dump_panes "$2" || true
  tmux kill-session -t "$(rv2_session)" 2>/dev/null || true
  "$V2_DIR/checkpoint.sh" >/dev/null 2>&1 || true
  exit 0
}

elapsed=0
dead_polls=0
while [ ! -f "$REVIEW" ]; do
  if [ "$elapsed" -ge "$TIMEOUT_S" ]; then
    give_up "timeout after ${elapsed}s - wrapper reports infrastructure_failure" wait-timeout
  fi
  # Do not sit out the full timeout on a corpse. A trunk that dies at 00:30 used to burn the
  # remaining 24 minutes of runner time before anyone could see it had died, and the review
  # was already lost at the first poll.
  if rv2_alive "$(rv2_trunk_index)"; then
    dead_polls=0
  else
    dead_polls=$((dead_polls + 1))
    if [ "$dead_polls" -ge "$DEAD_LIMIT" ]; then
      give_up "trunk pane dead for $((dead_polls * POLL_S))s with no review.json after ${elapsed}s - giving up early" \
              trunk-died
    fi
  fi
  sleep "$POLL_S"
  elapsed=$((elapsed + POLL_S))
done

echo "wait-review: review.json present after ${elapsed}s"
tmux kill-session -t "$(rv2_session)" 2>/dev/null || true
exit 0
