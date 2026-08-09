#!/usr/bin/env bash
# Send a directive to a worker pane in the v2 review tmux session, and keep the
# ledger honest in the same breath.
#
# Ported from ~/orch/dispatch.sh (the failure modes below each cost that fleet
# real worker-hours and are preserved verbatim):
#   - text and Enter sent as one keystroke sequence -> directive sits unsent in
#     the input box and the worker looks idle on the next patrol;
#   - a directive sent while the session is still booting -> silently swallowed;
#   - a stale draft already in the box -> the old text gets submitted instead
#     of the new one;
#   - the ledger not updated -> checkpoint/patrol cross-check wrong state.
#
# Usage: v2/dispatch.sh [--queue] <window> <assignment-id> <task-name> <directive...>
#        v2/dispatch.sh W1 s-0 TEST "Assignment s-0: paths [...]"
#
# Enforced here, not advisory:
#   - ASCII-only directive text (refusing beats silently mangling a pane).
#   - active-worker cap (RV2_MAX_ACTIVE, default 2) from the ledger: the trunk
#     pacing tool, making the ENGINE524 first-byte lesson deterministic.
set -uo pipefail

V2_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=v2/lib.sh
. "$V2_DIR/lib.sh"

QUEUE=0
if [ "${1:-}" = "--queue" ]; then QUEUE=1; shift; fi

w=${1:?usage: dispatch.sh [--queue] <window> <assignment-id> <task-name> <directive...>}
assignment=${2:?usage: dispatch.sh <window> <assignment-id> <task-name> <directive...>}
task=${3:?usage: dispatch.sh <window> <assignment-id> <task-name> <directive...>}
shift 3
text="$*"
[ -n "$text" ] || { echo "dispatch.sh: empty directive" >&2; exit 64; }

# Map W1/W2 to pane indexes; refuse the trunk pane (W0) outright.
case "$w" in
  W1) pane_index=1 ;;
  W2) pane_index=2 ;;
  *) echo "dispatch.sh: unknown window '$w' (expect W1 or W2; W0 is the trunk)" >&2; exit 64 ;;
esac

rv2_assert_ascii "$text" || exit 64

# The active-worker cap. Read the ledger: any row in status=dispatched whose
# assignment is not yet complete counts against the cap. Refusing here is the
# trunk's load limiter - firing more than ~2 relay requests at once is what
# killed the summary stage with 524s.
active="$(rv2_active_count)"
max_active="$(rv2_max_active)"
if [ "$QUEUE" -eq 0 ] && [ "$active" -ge "$max_active" ]; then
  echo "dispatch.sh: $active active assignments at/over the cap of $max_active - not dispatching $assignment" >&2
  exit 75
fi

is_pi=1  # workers always run pi in the v2 harness
if ! rv2_alive "$pane_index"; then
  echo "dispatch.sh: W$pane_index has no pi process - relaunch it first" >&2
  exit 69
fi
rv2_untranscript "$pane_index"
if rv2_dialog_up "$pane_index"; then
  echo "dispatch.sh: W$pane_index has a modal dialog up - input goes nowhere; resolve it first" >&2
  exit 65
fi

if [ "$QUEUE" -eq 0 ]; then
  if ! rv2_wait_idle "$pane_index" 60 "$is_pi"; then
    echo "dispatch.sh: W$pane_index still busy after 60s - not interrupting; re-run when it settles (or --queue)" >&2
    exit 75
  fi
  # Clear whatever is in the box. A leftover draft would be submitted by our Enter.
  tmux send-keys -t "$(rv2_session):$pane_index" C-u
  sleep 0.5
fi

send_once() {
  tmux send-keys -t "$(rv2_session):$pane_index" -l "$text"
  sleep 0.7
  tmux send-keys -t "$(rv2_session):$pane_index" Enter
  sleep 4
}

# pi's only accept signal is going busy (Working...). Poll rather than sample:
# the TUI can take seconds to render the running state after Enter.
accepted() {
  local i
  for i in $(seq 1 10); do
    rv2_pi_busy "$pane_index" && return 0
    sleep 1
  done
  return 1
}

send_once
if ! accepted; then
  rv2_untranscript "$pane_index"
  tmux send-keys -t "$(rv2_session):$pane_index" C-u; sleep 0.5
  send_once
fi

mkdir -p "$(rv2_orch)/directives"
{
  printf '# W%s current brief\n\n' "$pane_index"
  printf -- '- task: %s\n' "$task"
  printf -- '- dispatched: %s\n\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '%s\n' "$text"
} > "$(rv2_orch)/directives/W$pane_index.md"

rv2_ledger_row "W$pane_index" "$assignment" "$task" "dispatched"

if accepted; then
  echo "W$pane_index <- $assignment ($task, accepted)"
else
  echo "W$pane_index <- $assignment ($task, WARNING: pane did not go busy after two attempts)" >&2
  exit 1
fi
