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
# Whatever wait-for-relay.sh spent waiting for the CPU gate comes out of here.
# The two budgets share one 60-minute job, and a pre-wait that is not subtracted
# turns a clean INFRA into a job GitHub kills - which produces no synthesized
# review.json and no artifact at all. Floored well above zero so a long wait
# still leaves a review that can plausibly finish rather than one that times out
# on arrival.
WAITED_S="${RV2_RELAY_WAITED_S:-0}"
if [ "$WAITED_S" -gt 0 ] 2>/dev/null; then
  TIMEOUT_S=$((TIMEOUT_S - WAITED_S))
  [ "$TIMEOUT_S" -lt 600 ] && TIMEOUT_S=600
  echo "wait-review: relay wait consumed ${WAITED_S}s - review budget is now ${TIMEOUT_S}s"
fi
POLL_S="${RV2_REVIEW_POLL_S:-20}"

# Consecutive dead polls before believing the trunk is gone. A single miss is not proof:
# rv2_alive looks for a claude/pi/node child of the pane, and there is a real gap between
# one command exiting and the next starting.
DEAD_LIMIT="${RV2_TRUNK_DEAD_POLLS:-3}"

# Nudge an IDLE trunk instead of waiting out the clock beside it.
#
# 2026-08-10, run 31376928375: the trunk booted, took its brief, hit
# "API Error: 503 system cpu overloaded (current: 97.2%, threshold: 90%)" from
# the relay, retried for three minutes, gave up, and sat at an empty prompt for
# the remaining forty-seven. Every component behaved correctly. rv2_alive saw a
# live claude, because it was live. The timeout fired, because time passed. And
# the reason was on the screen the whole time, in one line, unread.
#
# A trunk that is alive and NOT busy has ended its turn without writing
# review.json, and the only thing that will start another turn is input. There is
# nobody at the keyboard, so the harness is the only one who can send it. A 503
# from a shedding relay is not a verdict and must not become one by default.
NUDGE_AFTER_POLLS="${RV2_TRUNK_IDLE_POLLS:-3}"
MAX_NUDGES="${RV2_TRUNK_MAX_NUDGES:-20}"
ERROR_FILE="$(rv2_root)/logs/trunk-last-error.txt"
nudges=0
last_error=''

# What the pane is complaining about, in one line, so the INFRA verdict can name
# a cause. "died or timed out" sends the next person to look at the harness;
# "503 system cpu overloaded" sends them to the relay, which is where the
# problem actually was.
record_pane_error() {
  local seen
  seen="$(rv2_pane "$(rv2_trunk_index)" | grep -oE '(API Error|Error): [^│]{0,200}' | tail -1 || true)"
  [ -n "$seen" ] || return 0
  last_error="$seen"
  mkdir -p "$(dirname "$ERROR_FILE")"
  printf '%s\n' "$seen" >"$ERROR_FILE"
}

nudge_trunk() {
  local line
  line="review.json is still not written and you are idle. If a request failed, RETRY it -"
  line="$line the relay sheds under host load and a 503 is not a final answer."
  line="$line Re-read the brief if you need it and continue until review.json exists."
  rv2_assert_ascii "$line" || return 0
  tmux send-keys -t "$(rv2_session):$(rv2_trunk_index)" -l "$line" 2>/dev/null || return 0
  tmux send-keys -t "$(rv2_session):$(rv2_trunk_index)" Enter 2>/dev/null || return 0
  nudges=$((nudges + 1))
  echo "wait-review: trunk idle at ${elapsed}s - nudge #$nudges${last_error:+ (pane says: $last_error)}"
}

# Capture the panes, THEN kill. Order matters: kill-session destroys the only copy of what
# the trunk and workers printed. Trial 4 booted cleanly, ran to the wrapper, and produced
# decision=infrastructure_failure with "trunk produced no review.json" - and its artifact had
# no logs, no evidence, no ledger, no directives, because the trunk died after boot and the
# session was killed with nothing read out of it. The boot path already dumps panes; this is
# the same failure one step later, and it was invisible for the same reason.
#
# `if`, not `[ x ] && echo`. Under set -e a false test at the head of an && list takes the
# function's exit status with it, and this function's whole job is to run the two lines BELOW
# the reporting - so the shorthand would have skipped the pane dump on exactly the runs with
# no recorded error, which are the ones with the least other evidence.
give_up() {
  echo "wait-review: $1"
  if [ -n "$last_error" ]; then
    echo "wait-review: last error seen on the trunk pane: $last_error"
  fi
  if [ "$nudges" -gt 0 ]; then
    echo "wait-review: the trunk was nudged $nudges time(s) and still produced nothing"
  fi
  rv2_dump_panes "$2" || true
  tmux kill-session -t "$(rv2_session)" 2>/dev/null || true
  "$V2_DIR/checkpoint.sh" >/dev/null 2>&1 || true
  exit 0
}

elapsed=0
idle_polls=0
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
    # Alive is not the same as working, and the gap between them is where a whole
    # run was lost. Busy resets the counter; idle accumulates toward a nudge.
    if rv2_busy "$(rv2_trunk_index)"; then
      idle_polls=0
    else
      idle_polls=$((idle_polls + 1))
      if [ "$idle_polls" -ge "$NUDGE_AFTER_POLLS" ]; then
        record_pane_error
        if [ "$nudges" -lt "$MAX_NUDGES" ]; then
          nudge_trunk
        elif [ "$nudges" = "$MAX_NUDGES" ]; then
          # Say it once. An idle trunk that has ignored twenty nudges is not going
          # to answer the twenty-first, and a log line every minute buries the one
          # that matters.
          nudges=$((nudges + 1))
          echo "wait-review: trunk still idle after $MAX_NUDGES nudges - no longer nudging${last_error:+ (pane says: $last_error)}"
        fi
        idle_polls=0
      fi
    fi
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
