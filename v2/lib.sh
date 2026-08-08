#!/usr/bin/env bash
# Shared helpers for the v2 runner orchestration harness.
#
# Everything here is ASCII-only by construction: worker panes receive text only
# through the dispatch discipline, and non-ASCII input is rejected at the door.
# Shell out to this file with `set -euo pipefail` already on in the caller.
#
# Layout is the Node harness contract (harness/layout.mjs): a single state root
# (RV2_ROOT / HARNESS_DIR) holding ledger.tsv, directives/, assignments/,
# evidence/, checkpoint/, resume/, output/, logs/. The bash side owns the
# orchestration side effects (tmux panes, ledger, directives); the Node side
# (harness/checkpoint.mjs, harness/validate-review.mjs) is the authority for
# the data contracts (evidence validation, checkpoint, review.json). The bash
# shims translate the RV2_* env into the Node env and delegate.
#
# Env vars (set by the workflow / boot script):
#   RV2_ROOT      state root (default $PWD) - same value as HARNESS_DIR
#   RV2_REPOSITORY  owner/repo under review (for gh queries + messages)
#   PR_NUMBER / HEAD_OID / ENGINE_PIN / RUN_ID  Node resume-key identity
#   RV2_TRUNK     trunk pane index (default 0) - never dispatched to
#   RV2_WORKERS   worker pane indexes (default "1 2")
#   RV2_MAX_ACTIVE  hard cap on simultaneously dispatched-but-not-complete shards
#                   (default 2 - the ENGINE524 relay first-byte lesson)

rv2_session() { printf '%s' "${RV2_SESSION:-bong-v2}"; }
rv2_root()   { printf '%s' "${RV2_ROOT:-$PWD}"; }
rv2_orch()   { rv2_root; }
rv2_evidence(){ printf '%s' "$(rv2_root)/evidence"; }
rv2_output() { printf '%s' "$(rv2_root)/output"; }
rv2_trunk_index() { printf '%s' "${RV2_TRUNK:-0}"; }
rv2_worker_indexes() { printf '%s' "${RV2_WORKERS:-1 2}"; }
rv2_max_active() { printf '%s' "${RV2_MAX_ACTIVE:-2}"; }

# Node identity env, with RV2_* fallbacks so both spellings work.
rv2_pr_number()  { printf '%s' "${PR_NUMBER:-${RV2_PR_NUMBER:-}}"; }
rv2_head_oid()   { printf '%s' "${HEAD_OID:-${RV2_HEAD_OID:-}}"; }
rv2_engine_pin() { printf '%s' "${ENGINE_PIN:-${RV2_ENGINE_PIN:-}}"; }
rv2_run_id()     { printf '%s' "${RUN_ID:-${RV2_RUN_ID:-local-run}}"; }

# Reject non-ASCII text destined for a pane. Refusing beats silently mangling:
# send-keys -l passes bytes through and the TUI renders mojibake. This is the
# standing rule from ~/orch/dispatch.sh, ported verbatim.
rv2_assert_ascii() {
  local text="$1"
  if LC_ALL=C grep -qP '[^\x09\x20-\x7E]' <<<"$text"; then
    echo "rv2: text contains non-ASCII; pane input is ASCII-only" >&2
    return 64
  fi
  return 0
}

# tmux capture for a pane; empty on any failure.
rv2_pane() {
  tmux capture-pane -t "$(rv2_session):$1" -p 2>/dev/null
}

# Is the pane running claude (trunk) and currently busy?
rv2_trunk_busy() {
  local p
  p="$(rv2_pane "$(rv2_trunk_index)")"
  grep -q 'esc to interrupt' <<<"$p"
}

# Is the pane running pi (worker) and currently busy? pi's only busy signal is
# the 'Working...' status line (lib-state.sh owns that call locally; ported).
rv2_pi_busy() {
  local p
  p="$(rv2_pane "$1")"
  grep -qF 'Working...' <<<"$p"
}

# Liveness from the process table, never the pane: after a host reboot tmux
# restores each pane's last pre-crash frame, status bar and all, so a dead
# window still *looks* alive.
rv2_alive() {
  local pp
  pp=$(tmux list-panes -t "$(rv2_session):$1" -F '#{pane_pid}' 2>/dev/null | head -1)
  [ -n "$pp" ] || return 1
  pgrep -P "$pp" -f 'claude|pi|node' >/dev/null 2>&1
}

# The detailed-transcript view (ctrl+o in claude) has no input box, so
# send-keys goes nowhere. Toggle out first; it is a no-op when not active.
rv2_untranscript() {
  local p
  p="$(rv2_pane "$1")"
  grep -q 'Showing detailed transcript' <<<"$p" || return 0
  tmux send-keys -t "$(rv2_session):$1" C-o
  sleep 1
}

# A modal dialog eats input outright - unlike a busy composer, which queues it.
rv2_dialog_up() {
  rv2_pane "$1" | grep -qE 'Switch model\?|\[y/N\]|Yes|No' && return 0
  return 1
}

# Wait up to timeout_s for the pane to stop being busy. Returns 0 when quiet.
rv2_wait_idle() {
  local pane_index="$1" timeout_s="${2:-60}" is_pi="${3:-0}"
  local i
  for i in $(seq 1 "$((timeout_s / 3))"); do
    if [ "$is_pi" -eq 1 ]; then rv2_pi_busy "$pane_index" || return 0
    else rv2_trunk_busy || return 0; fi
    sleep 3
  done
  return 1
}

# Append a ledger row. TSV (worker \t assignment \t utc \t status); the task
# name lives in the directive file, not the ledger. The checkpoint snapshots
# this file verbatim, so the format is also the forensic record.
rv2_ledger_row() { # window assignment task status  (task recorded in directive)
  local ledger="$(rv2_orch)/ledger.tsv"
  mkdir -p "$(rv2_orch)"
  [ -f "$ledger" ] || printf 'worker\tassignment\tutc\tstatus\n' >"$ledger"
  printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$(date -u +%Y-%m-%dT%H:%MZ)" "$4" >>"$ledger"
}

rv2_ledger_set_status() {
  local ledger="$(rv2_orch)/ledger.tsv"
  [ -f "$ledger" ] || return 0
  local tmp
  tmp="$(mktemp)"
  awk -F'\t' -v OFS='\t' -v w="$1" -v st="$2" -v now="$(date -u +%Y-%m-%dT%H:%MZ)" \
    '$1==w{$4=st; $3=now} {print}' "$ledger" >"$tmp" && mv "$tmp" "$ledger"
}

# A shard is complete when its evidence file lands at evidence/<id>.json
# (assignment-level idempotency, design 5.7a). harness/evidence.mjs is the
# authority for whether it is VALID; this is the fast existence check used by
# the concurrency gate and the checkpoint scan.
rv2_assignment_complete() {
  local id="$1"
  [ -f "$(rv2_evidence)/$id.json" ]
}

# Count of assignments currently dispatched-but-not-complete (the concurrency
# gate: never exceed RV2_MAX_ACTIVE, the 524 first-byte lesson).
rv2_active_count() {
  local ledger="$(rv2_orch)/ledger.tsv" count=0 id
  [ -f "$ledger" ] || { echo 0; return 0; }
  while IFS=$'\t' read -r _ a _ st; do
    [ "$st" = "dispatched" ] || continue
    id="$a"
    rv2_assignment_complete "$id" || count=$((count + 1))
  done < <(tail -n +2 "$ledger")
  echo "$count"
}
