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

# Panes run a POSIX shell we name, NOT the user's login shell.
#
# tmux starts default-shell in every pane, and everything this script types into
# a pane is sh/bash syntax - `set -a`, `.`, `if [ ]; then ... fi`. Measured
# 2026-08-10: on a host whose login shell is fish, every launch line failed
# silently, the panes sat at a fish prompt, and claude never started. The boot
# still reported success because it only checks that a process is alive, and a
# fish prompt is a live process.
#
# CI would not have caught this - GitHub runners default to bash - so the harness
# only worked there by accident of the host's shell.
PANE_SHELL="${RV2_PANE_SHELL:-/bin/bash}"
[ -x "$PANE_SHELL" ] || { echo "boot: pane shell $PANE_SHELL is not executable" >&2; exit 78; }

# Every pane runs Claude Code in a HOME the harness owns, and that HOME has to
# have its first-run gates cleared BEFORE the first pane launches - a pane that
# comes up on the theme picker never becomes a reviewer.
PANE_HOME="$(rv2_pane_home)"
"$V2_DIR/seed-claude-config.sh"

tmux kill-session -t "$SESSION" 2>/dev/null || true
tmux new-session -d -s "$SESSION" -x 220 -y 55 "$PANE_SHELL"
tmux set-option -t "$SESSION" history-limit 5000
# Belt and braces for any window created later by another code path.
tmux set-option -t "$SESSION" default-shell "$PANE_SHELL" 2>/dev/null || true

# The session starts with exactly one window; the worker windows must be
# created explicitly (send-keys to a nonexistent window aborts the boot).
# Indexes are forced so a user tmux.conf with base-index != 0 cannot shift
# the trunk/worker layout the rest of the harness addresses by number.
first_window="$(tmux list-windows -t "$SESSION" -F '#{window_index}' | head -1)"
if [ "$first_window" != "$TRUNK_INDEX" ]; then
  tmux move-window -s "$SESSION:$first_window" -t "$SESSION:$TRUNK_INDEX"
fi
for i in $WORKERS; do
  tmux new-window -d -t "$SESSION:$i" "$PANE_SHELL"
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
  # Never type into a pane whose screen has not been read. A first-run wizard
  # accepts keystrokes and Enter perfectly happily, and turns a brief into menu
  # navigation; rv2_wait_prompt_box names the screen instead of guessing.
  rv2_wait_prompt_box "$i" "${RV2_PROMPT_BOX_TIMEOUT_S:-90}" || return 1
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

# V2_DIR must be EXPORTED into every pane, not just known to this script.
#
# trunk-prompt.md tells the trunk to run "$V2_DIR/shard-diff.sh",
# ". $V2_DIR/lib.sh", "$V2_DIR/dispatch.sh", "$V2_DIR/checkpoint.sh" and to point
# workers at "$V2_DIR/worker-brief.md" - five commands. A pane is its own login
# shell, so without this every one of them expands to /shard-diff.sh and the
# trunk can do nothing at all. The workflow's job-level env cannot carry it
# because the value is only known here, at runtime, from $0.
#
# It has been surviving on the seed line quoting an ABSOLUTE path to the prompt
# file, leaving the trunk to infer its directory. That is asking a model to
# reconstruct a path we already have, and it fails silently into "the trunk did
# nothing" - the least diagnosable failure this harness has.
# EVERY variable a pane needs is passed EXPLICITLY. Nothing is inherited.
#
# tmux panes inherit the environment of the tmux SERVER, not of the process that
# ran send-keys. When boot-session.sh starts the server itself - the CI case -
# that happens to be the same thing, so the harness appeared to work. Attach to
# a server someone else started and the panes get that server's environment
# instead: measured on 2026-08-10, the trunk came up with no ANTHROPIC_BASE_URL,
# dialled the public API, and reported "the selected model (cc-review) may not
# exist" - a credential/routing failure wearing a model-name error's clothes.
# It also inherited an UNRELATED token that happened to be in the other server.
#
# The relay pair goes through a mode-600 file rather than onto the command line.
# A send-keys line is visible in the pane, and rv2_dump_panes captures panes into
# logs/ on failure, and logs/ is uploaded as an artifact - so a token typed into
# a pane is a token in an artifact. The file lives OUTSIDE the state root for the
# same reason, and is removed once the panes are seeded.
RELAY_ENV="$(mktemp -t rv2-relay-XXXXXX)"
chmod 600 "$RELAY_ENV"
trap 'rm -f "$RELAY_ENV"' EXIT
{
  printf 'ANTHROPIC_BASE_URL=%s\n' "${ANTHROPIC_BASE_URL:-}"
  printf 'ANTHROPIC_AUTH_TOKEN=%s\n' "${ANTHROPIC_AUTH_TOKEN:-}"
} >"$RELAY_ENV"

# An `if`, not a brace group, and &&-chained rather than semicolon-separated.
#
# Two ways this silently half-works if written the obvious way. `cd X && set -a;
# . f; set +a` parses as four separate commands, so a failed cd does not stop the
# rest. And `{ set -a; . f; set +a; }` returns the status of its LAST command -
# `set +a`, always 0 - so a MISSING relay file is swallowed and the pane launches
# claude with no credentials anyway. Verified both: the brace form printed
# "REACHED CLAUDE" with the file absent.
#
# That is the same defect as reading a pipeline's exit status, and the failure it
# produces is the one measured today: a pane with no ANTHROPIC_BASE_URL dials the
# public API and reports "the selected model (cc-review) may not exist", which
# sends you to look at the model list instead of at the credentials.
PANE_ENV="if [ -r '$RELAY_ENV' ]; then set -a; . '$RELAY_ENV'; set +a;"
PANE_ENV="$PANE_ENV else echo 'rv2: relay env file missing: $RELAY_ENV' >&2; false; fi"
PANE_ENV="$PANE_ENV && export HOME='$PANE_HOME' V2_DIR='$V2_DIR_ABS'"
# Keep the hash-pinned binary the only Claude Code on the box. See
# seed-claude-config.sh: a fresh HOME staged an unpinned 2.1.226 and cloned the
# plugin marketplace within seconds. The config flags say the same thing; this
# says it in a form a config merge cannot drop.
PANE_ENV="$PANE_ENV DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1"
PANE_ENV="$PANE_ENV CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL=1"
PANE_ENV="$PANE_ENV RV2_ROOT='$ROOT' HARNESS_DIR='$ROOT'"
PANE_ENV="$PANE_ENV RV2_REPOSITORY='${RV2_REPOSITORY:-}' PR_NUMBER='${PR_NUMBER:-}'"
PANE_ENV="$PANE_ENV HEAD_OID='$(rv2_head_oid)' RV2_BINARY_PATH='${RV2_BINARY_PATH:-}'"
PANE_ENV="$PANE_ENV RV2_BUILD_RUN_ID='${RV2_BUILD_RUN_ID:-}'"
# The project review policy, taken from the BASE commit by the workflow. The trunk is required
# to read it: the manifest binds its SHA-256, so a review that ignored it would ship a
# provenance claim it did not earn.
PANE_ENV="$PANE_ENV RV2_POLICY_FILE='${RV2_POLICY_FILE:-}'"

if [ "${RV2_FAKE:-0}" = "1" ]; then
  tmux send-keys -t "$SESSION:$TRUNK_INDEX" \
    "cd '$ROOT' && $PANE_ENV && bash '$V2_DIR_ABS/../fake/trunk.sh'" Enter
else
  tmux send-keys -t "$SESSION:$TRUNK_INDEX" \
    "cd '$ROOT' && $PANE_ENV && '$CLAUDE_BIN' --model '$(rv2_trunk_model)' --dangerously-skip-permissions" Enter
  # No fixed sleep before seeding: seed_pane polls for the input box, which both
  # waits less on a fast boot and does not type into a slow one.
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
    tmux send-keys -t "$SESSION:$i" "cd '$ROOT' && $PANE_ENV && node '$V2_DIR_ABS/../fake/worker.mjs' W$i" Enter
  else
    tmux send-keys -t "$SESSION:$i" "cd '$ROOT' && $PANE_ENV && $WORKER_LAUNCH" Enter
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
