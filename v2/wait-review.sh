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
# Sized against the JOB timeout, not picked. The review job is 60 minutes; the
# wrapper and the artifact upload both run `if: always()` and must still fit
# after this expires, because a job killed by GitHub produces no synthesized
# review.json and no artifact at all - strictly worse than a clean INFRA. 3000s
# leaves 10 minutes for that tail. test/v2-runner-orchestration.test.mjs asserts
# the relationship so the two numbers cannot drift apart.
#
# It was 1500s, which left 35 of the job's 60 minutes unused. That was sized for
# P1 test mode - scripts only, nothing built. Probe mode changes the shape: the
# crew stands a server up and drives it, two workers serially over N
# assignments, so slow-but-alive is now the normal case rather than a symptom.
#
# Raising it is only safe because the timeout no longer doubles as a liveness
# detector: a dead trunk is caught by the dead_polls path below within
# DEAD_LIMIT polls and gives up immediately. The timeout now binds ONLY on a
# trunk that is alive and working, which is exactly the case that should be
# allowed to finish. A timeout that fires there is not a safety net, it is a
# lost run - and it costs a taskq attempt, which is how PRs end up parked at
# "attempt 2 of 3".
TIMEOUT_S="${RV2_REVIEW_TIMEOUT_S:-3000}"
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
