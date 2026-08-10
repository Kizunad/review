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

# A signal handler that does not exit is not a shutdown, it is a side effect.
#
# This was `trap cleanup EXIT INT TERM` with no exit in cleanup. bash runs the
# handler and then RESUMES the loop, so SIGTERM wrote a checkpoint and left the
# watchdog running. On a CI runner nothing noticed - the VM is destroyed at the
# end of the job. Locally it meant every smoke run leaked an immortal watchdog:
# 60 of them accumulated on this host, each waking to spawn a CPU-heavy
# checkpoint write, and the pile pushed the box past New API's 90% host-CPU gate
# and took central review down for a night. Trying to kill them made it worse -
# every SIGTERM fired one more checkpoint and killed nothing.
#
# EXIT is separate from INT/TERM on purpose: an exit trap that calls exit
# re-enters itself.
final_checkpoint() {
  echo "watchdog: final checkpoint"
  "$V2_DIR/checkpoint.sh" 2>/dev/null || true
}
trap final_checkpoint EXIT

# The sleep runs in the BACKGROUND and we wait on it, which is the only reason
# the trap above fires promptly.
#
# bash runs a trap handler only after the currently-executing command returns.
# With a foreground `sleep "$INTERVAL"` the signal goes to the shell, the sleep
# child never sees it, and the handler waits out the whole interval - five
# minutes at the default, and indefinitely for anything longer. Fixing the
# missing `exit` alone still left a watchdog that looked immortal for minutes,
# which is exactly how a "cleanup" step gets written off as working.
#
# `wait` IS interruptible, so the handler runs at once and kills the sleep.
running=1
shutdown() {
  running=0
  [ -n "${sleep_pid:-}" ] && kill "$sleep_pid" 2>/dev/null
  return 0
}
trap shutdown INT TERM

while [ "$running" = 1 ]; do
  sleep "$INTERVAL" &
  sleep_pid=$!
  wait "$sleep_pid" 2>/dev/null || true
  [ "$running" = 1 ] || break
  "$V2_DIR/checkpoint.sh" 2>/dev/null || echo "watchdog: checkpoint failed; retrying next interval" >&2
done
