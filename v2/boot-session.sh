#!/usr/bin/env bash
# Boot the v2 review tmux session (design 5.5): trunk pane (headless claude) +
# worker panes (pi TUIs, or the deterministic fake worker when RV2_FAKE=1) +
# checkpoint watchdog. Called by the review job. After boot the job waits for
# $HARNESS_DIR/output/review.json (wait-review.sh) and then runs wrapper.sh.
#
# The layout is the Node harness contract (harness/layout.mjs): the state root
# holds ledger.tsv, directives/, assignments/, evidence/, checkpoint/, resume/,
# output/, logs/.
set -euo pipefail

V2_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=v2/lib.sh
. "$V2_DIR/lib.sh"

rv2_require_relay || exit $?

SESSION="$(rv2_session)"
ORCH="$(rv2_orch)"
mkdir -p "$ORCH"
ROOT="$(rv2_root)"
TRUNK_INDEX="$(rv2_trunk_index)"
WORKERS="$(rv2_worker_indexes)"
V2_DIR_ABS="$(cd "$V2_DIR" && pwd)"

# claude executable: absolute path from setup-claude (GITHUB_ENV), else `claude`.
CLAUDE_BIN="${CLAUDE_EXECUTABLE:-claude}"

# The crew is Claude Code on the lite tier, launched INTERACTIVE (no -p) because
# the whole dispatch model is the trunk typing directives into a live pane. A
# headless worker has no box to type into.
#
# --dangerously-skip-permissions is the point, not a shortcut: the crew's job is
# to write tests, run them, and stand a minimal server up. A permission prompt in
# an unattended pane is a hang, and a curated tool whitelist is what made the old
# engine a read-only reasoner. The sandbox is the ephemeral runner VM (design
# 5.5: "跑 PR 代码的沙箱就是 VM"), not a flag list.
WORKER_LAUNCH="'$CLAUDE_BIN' --model '$(rv2_worker_model)' --dangerously-skip-permissions"

tmux kill-session -t "$SESSION" 2>/dev/null || true
tmux new-session -d -s "$SESSION" -x 220 -y 55
tmux set-option -t "$SESSION" history-limit 5000

# The session starts with exactly one window; the worker windows must be
# created explicitly (send-keys to a nonexistent window aborts the boot).
# Indexes are forced so a user tmux.conf with base-index != 0 cannot shift
# the trunk/worker layout the rest of the harness addresses by number.
first_window="$(tmux list-windows -t "$SESSION" -F '#{window_index}' | head -1)"
if [ "$first_window" != "$TRUNK_INDEX" ]; then
  tmux move-window -s "$SESSION:$first_window" -t "$SESSION:$TRUNK_INDEX"
fi
for i in $WORKERS; do
  tmux new-window -d -t "$SESSION:$i"
done

# EVERY pane is an interactive Claude Code process - trunk included.
#
# The trunk used to run `claude -p`. Three things were wrong with that. The
# operator's rule is that a reviewer is a worker, not a one-shot question. The
# harness already greps the trunk pane for 'esc to interrupt', which a -p process
# never prints, so rv2_trunk_busy could not have worked (it had no callers, so
# nothing noticed). And the design ports autonudge/催办 onto the trunk, which
# needs a box to type into - a -p trunk that stalls can only be killed by the
# wall-clock watchdog.
#
# Nothing depends on the trunk process EXITING: wait-review.sh polls for
# output/review.json and the job tears the session down afterwards.
#
# RV2_FAKE=1 swaps in deterministic stubs so the local smoke exercises the SAME
# pane lifecycle, dispatch plumbing, and wrapper contract without any LLM.
seed_pane() {
  local i="$1" line="$2" tries t
  for tries in 1 2 3; do
    tmux send-keys -t "$SESSION:$i" -l "$line"
    tmux send-keys -t "$SESSION:$i" Enter
    for t in $(seq 1 15); do
      rv2_busy "$i" && return 0
      sleep 1
    done
  done
  echo "boot: pane $i seed not accepted after 3 tries" >&2
  return 1
}

if [ "${RV2_FAKE:-0}" = "1" ]; then
  tmux send-keys -t "$SESSION:$TRUNK_INDEX" \
    "cd '$ROOT' && bash '$V2_DIR_ABS/../fake/trunk.sh'" Enter
else
  tmux send-keys -t "$SESSION:$TRUNK_INDEX" \
    "cd '$ROOT' && '$CLAUDE_BIN' --model '$(rv2_trunk_model)' --dangerously-skip-permissions" Enter
  sleep 12
  # Not backgrounded, unlike the workers: if the trunk never accepts its brief
  # there is no review to run, so failing here is better than booting a session
  # whose only agent is idle.
  seed_pane "$TRUNK_INDEX" \
    "Read $V2_DIR_ABS/trunk-prompt.md and execute it to completion. Do not stop until review.json is written or you physically cannot continue." \
    || { echo "boot: trunk never accepted its brief" >&2; rv2_dump_panes trunk-seed-refused; exit 1; }
fi

# Crew panes: cc-review-lite, seeded to read the brief. Best-effort - every
# dispatch directive tells the worker to re-read it, so a seed swallowed by a
# slow boot is recoverable.
for i in $WORKERS; do
  if [ "${RV2_FAKE:-0}" = "1" ]; then
    tmux send-keys -t "$SESSION:$i" "cd '$ROOT' && node '$V2_DIR_ABS/../fake/worker.mjs' W$i" Enter
  else
    tmux send-keys -t "$SESSION:$i" "cd '$ROOT' && $WORKER_LAUNCH" Enter
    sleep 12
    seed_pane "$i" "Read $V2_DIR_ABS/worker-brief.md; you are worker pane $i. Await the trunk's dispatch." &
  fi
done
wait || true

# Checkpoint watchdog in the background (PID recorded for diagnostics).
"$V2_DIR/checkpoint-watchdog.sh" &
echo "boot: watchdog pid $!"

# Wait for the trunk to be alive before returning; a dead trunk means the job
# should fail fast so the wrapper reports infrastructure_failure immediately.
for i in $(seq 1 30); do
  if rv2_alive "$TRUNK_INDEX"; then
    echo "boot: trunk pane alive ($CLAUDE_BIN)"
    tmux list-panes -t "$SESSION" -F '#{pane_index}: #{pane_current_command}'
    exit 0
  fi
  sleep 2
done
echo "boot: trunk pane never came alive" >&2
rv2_dump_panes trunk-never-alive
exit 1
