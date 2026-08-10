#!/usr/bin/env bash
# Boot the harness against a FRESH HOME and assert it reaches a usable pane.
#
# This is the test that did not exist on 2026-08-10, when three CI runs died at
# "boot: trunk never accepted its brief" while the same boot script worked on the
# operator's machine every time. The difference was not the runner: it was that
# interactive Claude Code shows three first-run screens (theme picker, security
# notes, trust-this-folder) on a HOME it has never seen, and the operator's HOME
# had cleared them in June. The seed line went into the theme picker's SELECT
# LIST, its Enter chose a theme, and the boot reported a refusal it could not
# explain.
#
# It costs no API traffic: the relay points at a closed port. The pane still
# reaches the input box, still accepts the seed, and still prints 'esc to
# interrupt' while it retries the connection - which is precisely the property
# under test. What is being verified is the SCREEN, not the model.
#
# Both directions are run. The seeded leg must reach the box; the unseeded leg
# must fail AND must name the theme picker. A test that only checks the happy
# path here would have passed on 2026-08-09 too.
#
# Usage: v2/test-boot-fresh-home.sh [/path/to/claude]
set -uo pipefail

V2_DIR="$(cd "$(dirname "$0")" && pwd)"

# Isolate the tmux server before anything else touches tmux.
#
# TMUX_TMPDIR alone does NOT isolate: with $TMUX set, tmux talks to the server
# named in it and ignores the tmpdir. Measured 2026-08-10 - a trial that
# believed it was isolated created its session on the FLEET's server, next to
# seventeen live workers. `env -u TMUX` is what actually separates them.
if [ -z "${RV2_TEST_ISOLATED:-}" ]; then
  d="$(mktemp -d -t rv2-test-tmux-XXXXXX)"
  exec env -u TMUX TMUX_TMPDIR="$d" RV2_TEST_ISOLATED=1 bash "$0" "$@"
fi

CLAUDE_BIN="${1:-${CLAUDE_EXECUTABLE:-claude}}"
command -v "$CLAUDE_BIN" >/dev/null 2>&1 || [ -x "$CLAUDE_BIN" ] || {
  echo "test-boot: no claude binary at '$CLAUDE_BIN'" >&2; exit 78; }

fails=0
ok()   { printf 'ok   - %s\n' "$1"; }
bad()  { printf 'FAIL - %s\n' "$1"; fails=$((fails + 1)); }

cleanup() {
  tmux kill-server 2>/dev/null
  pkill -f 'checkpoint-watchdog.sh' 2>/dev/null
  [ -n "${WORK:-}" ] && rm -rf "$WORK"
  [ -n "${TMUX_TMPDIR:-}" ] && rm -rf "$TMUX_TMPDIR"
  return 0
}
trap cleanup EXIT

# Assert the isolation actually happened rather than assuming it from the exec.
if tmux list-sessions >/dev/null 2>&1; then
  echo "test-boot: tmux server already has sessions - NOT isolated, refusing to run" >&2
  exit 70
fi

WORK="$(mktemp -d -t rv2-test-root-XXXXXX)"
mkdir -p "$WORK/root/repo"

export RV2_ROOT="$WORK/root"
export RV2_SESSION="rv2-test-$$"
export RV2_WORKERS="1"          # one crew pane is enough to test the lifecycle
export RV2_PANE_SHELL=/bin/bash
export CLAUDE_EXECUTABLE="$CLAUDE_BIN"
# A closed port, not an empty value: rv2_require_relay must pass (the credential
# IS configured) while no request can succeed (nothing is spent).
export ANTHROPIC_BASE_URL="http://127.0.0.1:1"
export ANTHROPIC_AUTH_TOKEN="sk-test-not-a-real-credential-000000"
# A checkpoint key the validator accepts (pullNumber >= 1, two 40-hex oids), so
# the watchdog's first tick writes a checkpoint instead of printing a node stack
# trace into the middle of the results.
export PR_NUMBER=1
export HEAD_OID=1111111111111111111111111111111111111111
export ENGINE_PIN=2222222222222222222222222222222222222222

# shellcheck source=v2/lib.sh
. "$V2_DIR/lib.sh"

echo "== leg 1: seeded HOME (the shipping path) =="
if "$V2_DIR/boot-session.sh"; then
  ok "boot-session.sh exited 0"
else
  bad "boot-session.sh failed (rc=$?)"
fi

if rv2_pane 0 | grep -q 'esc to interrupt'; then
  ok "trunk accepted its brief"
else
  bad "trunk did not accept its brief"
  rv2_pane 0 | tail -20
fi

PANE_HOME="$(rv2_pane_home)"
if [ -d "$PANE_HOME/.claude" ]; then
  ok "panes ran in the harness HOME ($PANE_HOME), not the ambient one"
else
  bad "harness HOME was never used - HOME is not reaching the panes"
fi

# The pin is only a pin if nothing newer lands next to it.
if [ -e "$PANE_HOME/.local/share/claude/versions" ] || [ -e "$PANE_HOME/.cache/claude/staging" ]; then
  bad "an unpinned Claude Code was downloaded into the harness HOME"
  ls -d "$PANE_HOME"/.local/share/claude/versions/* "$PANE_HOME"/.cache/claude/staging/* 2>/dev/null
else
  ok "no unpinned Claude Code was downloaded"
fi
if [ -e "$PANE_HOME/.claude/plugins/marketplaces" ]; then
  bad "the plugin marketplace was cloned into the harness HOME"
else
  ok "no plugin marketplace clone"
fi

# The screen CI actually stalled on. Named separately from "reached the input
# box" because its default option is "No, exit": a harness that blind-Entered
# through it would not stall, it would shut the trunk down, and the two failures
# look nothing alike from the outside.
if rv2_pane 0 | grep -q 'Bypass Permissions mode'; then
  bad "the bypass-permissions consent dialog is up - screen 4 is not cleared"
else
  ok "the bypass-permissions consent dialog never appeared"
fi

tmux kill-session -t "$RV2_SESSION" 2>/dev/null
pkill -f 'checkpoint-watchdog.sh' 2>/dev/null

echo
echo "== leg 2: UNSEEDED HOME (must fail, and must say why) =="
# Without this leg the first one proves nothing: a boot that would pass on an
# unseeded HOME too would mean the seeding is not what fixed it.
UNSEEDED="$WORK/unseeded-home"
mkdir -p "$UNSEEDED"
export RV2_SESSION="rv2-test-unseeded-$$"
tmux new-session -d -s "$RV2_SESSION" -x 220 -y 55 /bin/bash
sleep 1
# Ask tmux which window it made. Hard-coding 0 made this leg pass for the wrong
# reason on the first run: the operator's tmux.conf sets base-index 1, send-keys
# printed "can't find window: 0", claude never launched, and "did not reach the
# input box" was reported about an empty shell. The assertion was true and
# measured nothing - the same defect the leg exists to catch.
W="$(tmux list-windows -t "$RV2_SESSION" -F '#{window_index}' | head -1)"
tmux send-keys -t "$RV2_SESSION:$W" \
  "cd '$WORK' && HOME='$UNSEEDED' ANTHROPIC_BASE_URL='$ANTHROPIC_BASE_URL' ANTHROPIC_AUTH_TOKEN='$ANTHROPIC_AUTH_TOKEN' DISABLE_AUTOUPDATER=1 '$CLAUDE_BIN' --model cc-review-lite --dangerously-skip-permissions" Enter

# The pane must be RUNNING CLAUDE before its screen means anything.
for _ in $(seq 1 20); do
  [ "$(tmux display-message -p -t "$RV2_SESSION:$W" '#{pane_current_command}')" = "claude" ] && break
  sleep 1
done
if [ "$(tmux display-message -p -t "$RV2_SESSION:$W" '#{pane_current_command}')" = "claude" ]; then
  ok "the unseeded leg actually launched claude"
else
  bad "the unseeded leg never launched claude - it is measuring an empty shell"
fi

diag="$(rv2_wait_prompt_box "$W" 25 2>&1)"
if [ -n "$diag" ] && ! rv2_pane "$W" | grep -q 'bypass permissions on'; then
  ok "an unseeded HOME does NOT reach the input box"
else
  bad "an unseeded HOME reached the input box - the seeding is not what fixes this"
fi
if grep -q 'THEME PICKER' <<<"$diag"; then
  ok "the failure names the screen it is stuck on"
else
  bad "the failure did not name the screen (got: ${diag:-<nothing>})"
fi

echo
if [ "$fails" -eq 0 ]; then
  echo "test-boot-fresh-home: PASS"
  exit 0
fi
echo "test-boot-fresh-home: $fails FAILED"
exit 1
