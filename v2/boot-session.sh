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

# pi launch command: install-runner.sh publishes the literal cli.js path as
# RV2_PI_CLI precisely because a pane cannot be trusted to have the global npm
# bin on PATH (it runs its own login shell). Honor it; fall back to bare `pi`
# only when the install step did not publish one.
if [ -n "${RV2_PI_CLI:-}" ]; then
  PI_LAUNCH="node '$RV2_PI_CLI'"
else
  PI_LAUNCH="pi"
fi

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

# Trunk pane: headless claude runs the whole loop to completion. The prompt is
# a one-liner that points at trunk-prompt.md - the file holds the protocol and
# keeps the pane input short. RV2_FAKE=1 swaps in the deterministic stub trunk
# (fake/trunk.sh) so the local smoke exercises the SAME pane lifecycle,
# dispatch plumbing, and wrapper contract without touching any LLM.
if [ "${RV2_FAKE:-0}" = "1" ]; then
  tmux send-keys -t "$SESSION:$TRUNK_INDEX" \
    "cd '$ROOT' && bash '$V2_DIR_ABS/../fake/trunk.sh'" Enter
else
  tmux send-keys -t "$SESSION:$TRUNK_INDEX" \
    "cd '$ROOT' && '$CLAUDE_BIN' -p \"Read $V2_DIR_ABS/trunk-prompt.md and execute it to completion. Do not stop until review.json is written or you physically cannot continue.\"" Enter
fi

# Worker panes: pi TUIs seeded to read their brief (or the fake worker for a
# deterministic smoke). Seeding is best-effort - every dispatch directive tells
# the worker to re-read the brief, so a seed swallowed by a slow boot is fine.
seed_worker() {
  local i="$1" tries t
  for tries in 1 2 3; do
    tmux send-keys -t "$SESSION:$i" -l "Read $V2_DIR_ABS/worker-brief.md; you are worker pane $i. Await the trunk's dispatch."
    tmux send-keys -t "$SESSION:$i" Enter
    for t in $(seq 1 15); do
      rv2_pi_busy "$i" && return 0
      sleep 1
    done
  done
  echo "boot: worker $i seed not accepted after 3 tries (dispatch will re-brief)" >&2
}

for i in $WORKERS; do
  if [ "${RV2_FAKE:-0}" = "1" ]; then
    tmux send-keys -t "$SESSION:$i" "cd '$ROOT' && node '$V2_DIR_ABS/../fake/worker.mjs' W$i" Enter
  else
    tmux send-keys -t "$SESSION:$i" "cd '$ROOT' && $PI_LAUNCH" Enter
    sleep 12
    seed_worker "$i" &
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
