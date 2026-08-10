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

# HOME for the panes - owned by the harness, never the ambient one.
#
# Interactive Claude Code has three first-run gates (theme picker, security
# notes, trust-this-folder) and a fresh HOME hits all three before an input box
# exists. The operator's box cleared them in June, so the local trial saw none
# of them; every CI runner is a fresh HOME, so CI saw all three. That asymmetry
# is exactly the one PANE_SHELL already documents in boot-session.sh, pointing
# the other way, and it is why this is a harness-owned HOME rather than a patch
# to whatever HOME happens to be there: seeding the ambient one would rewrite a
# live config the operator's other sessions are using, AND would leave local and
# CI on different paths again - which is the shape of bug that produced it.
#
# Under the state root on purpose: scan-leaks.sh sweeps the root (minus repo/),
# so a credential a crew member echoes into a transcript is caught by the same
# pass that sweeps evidence.
#
# DO NOT ADD THIS DIRECTORY TO THE SCANNER'S EXCLUSION LIST. It holds Claude
# Code's session transcripts, which quote the files the crew read, so a PR that
# merely contains an SDK fixture key made the scanner alarm on every single run
# until the alarm meant nothing. The fix is NOT to stop scanning transcripts -
# they are precisely where a leaked credential lands - it is the provenance rule
# in scan-leaks.sh: a shape that is also present in repo/ is the pull request's
# own text and is recorded quietly; anything else is loud wherever it was found.
rv2_pane_home() { printf '%s' "${RV2_PANE_HOME:-$(rv2_root)/home}"; }

# Node identity env, with RV2_* fallbacks so both spellings work.
rv2_pr_number()  { printf '%s' "${PR_NUMBER:-${RV2_PR_NUMBER:-}}"; }
rv2_head_oid()   { printf '%s' "${HEAD_OID:-${RV2_HEAD_OID:-}}"; }
rv2_engine_pin() { printf '%s' "${ENGINE_PIN:-${RV2_ENGINE_PIN:-}}"; }
rv2_run_id()     { printf '%s' "${RUN_ID:-${RV2_RUN_ID:-local-run}}"; }

# Refuse to boot without the relay env, and say which name is empty.
#
# The 2026-08-09 trial spent two and a half minutes creating the session, launching pi twice,
# re-seeding both workers three times each, and then reported "boot: trunk pane never came
# alive" - which reads like a harness bug and cost an entire debugging round. It was not a
# harness bug: AXONHUB_BASE_URL and PI_AXONHUB_API_KEY were empty, because the workflow
# sourced them from secrets that exist in neither Kizunad/review nor Kizunad/Bong, so claude
# and pi both had nothing to dial and every pane exited on startup.
#
# A missing credential is a configuration error. It must be reported as one, before anything
# expensive runs, naming the variable - never as a runtime death two minutes later.
#
# 2026-08-10: the crew is cc-review-lite, not pi, so there is exactly ONE relay and one pair of
# names. The AXONHUB_BASE_URL / PI_AXONHUB_API_KEY pair existed only because pi refused to honor
# ANTHROPIC_BASE_URL and had to be routed through a vendored plugin; with pi gone both roles dial
# the same endpoint the same way. Two names for one relay is how the pair went empty unnoticed.
rv2_require_relay() {
  [ "${RV2_FAKE:-0}" = "1" ] && return 0   # the fake harness dials nothing
  local missing="" v
  for v in ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN; do
    [ -n "${!v:-}" ] || missing="$missing $v"
  done
  [ -n "$missing" ] || return 0
  {
    echo "rv2: relay env is empty:$missing"
    echo "rv2: the trunk ($(rv2_trunk_model)) and the crew ($(rv2_worker_model)) both dial this"
    echo "rv2: relay, so with these unset every pane dies at startup and the harness can only"
    echo "rv2: report that the pane never came alive. Fix the caller, not the harness."
    echo "rv2: a workflow_dispatch run only sees secrets defined on the repo that OWNS the"
    echo "rv2: workflow - Kizunad/review has none. Either call this workflow from Bong with"
    echo "rv2: secrets.review_api_key, or define the secret on Kizunad/review."
  } >&2
  return 78   # EX_CONFIG
}

# The two roles, and the whole of the model policy (design 5.9).
#
# sol judges and orchestrates and writes NOTHING; the crew acts and judges nothing. Keeping the
# names here rather than in each script means a pane cannot silently boot on the wrong tier - the
# failure that produces is a crew member reasoning instead of testing, which looks like a review.
#
# cc-review-lite runs on a small model BY DESIGN (operator, 2026-08-09). A "lite is degraded"
# reading has sent someone to fix a healthy config before; it is the correct tier for doing work
# under someone else's direction.
rv2_trunk_model()  { printf '%s' "${RV2_TRUNK_MODEL:-cc-review}"; }
rv2_worker_model() { printf '%s' "${RV2_WORKER_MODEL:-cc-review-lite}"; }

# Probe mode is available only when THIS pipeline built a binary from the reviewed head.
#
# Both variables are required together and are set by one workflow step, so a half-set pair
# means the plumbing broke rather than that probe is off. Reported as such instead of being
# quietly downgraded to "unavailable": "we chose not to build" and "the build path is broken"
# must not look identical to the trunk, because only one of them is a reason to review a
# server change without ever running it.
rv2_binary_path()  { printf '%s' "${RV2_BINARY_PATH:-}"; }
rv2_build_run_id() { printf '%s' "${RV2_BUILD_RUN_ID:-}"; }

rv2_probe_available() {
  local p="${RV2_BINARY_PATH:-}" r="${RV2_BUILD_RUN_ID:-}"
  # A build that was ASKED FOR and BROKE is state 2, not state 1. The caller wanted probe and
  # cannot have it because something is wrong - reviewing a server change without ever running
  # it, and calling that a clean review, is the outcome this distinction exists to prevent.
  if [ "${RV2_BUILD_FAILED:-0}" = "1" ]; then
    echo "rv2: the build job FAILED - probe was requested and the binary does not exist" >&2
    echo "rv2: this is not 'probe is off'; record a failure rather than falling back to static" >&2
    return 2
  fi
  if [ -z "$p" ] && [ -z "$r" ]; then return 1; fi          # not built - the normal case
  if [ -z "$p" ] || [ -z "$r" ]; then
    echo "rv2: RV2_BINARY_PATH and RV2_BUILD_RUN_ID must be set together (path='$p' runId='$r')" >&2
    echo "rv2: half-set means the build plumbing is broken, not that probe is disabled" >&2
    return 2
  fi
  [ -x "$p" ] || {
    echo "rv2: RV2_BINARY_PATH=$p is not an executable file - probe cannot run" >&2
    return 2
  }
  return 0
}

# THE CREDENTIAL VOCABULARY - ONE list, because there were nearly two.
#
# scan-leaks.sh DETECTS with these names and patterns; rv2_redact_stream below
# REDACTS with them. When the list lived only in scan-leaks.sh, the redactor did
# not exist at all and rv2_dump_panes copied pane text to stderr unfiltered - so
# the scanner swept the state root before a 7-day artifact upload while the same
# bytes went into the CI log, which GitHub keeps for 90 DAYS. scan-leaks.sh's own
# header says the thing it must never do is move a secret somewhere with longer
# retention than the artifact it was protecting; the pane dump was doing exactly
# that, out of the other side of the harness.
#
# A second copy of this list is how that comes back, so consumers call these.
rv2_credential_env_names() {
  printf '%s\n' ANTHROPIC_AUTH_TOKEN ANTHROPIC_API_KEY GITHUB_TOKEN GH_TOKEN
}

# ERE, one per line, deliberately unanchored - a token is a substring of a log
# line, not a whole line. ah- is the AxonHub relay's own prefix; the rest are the
# common vendors, for tokens that came from somewhere else and whose value we do
# not know.
rv2_credential_patterns() {
  printf '%s\n' \
    'sk-[A-Za-z0-9_-]{16,}' \
    'ah-[A-Za-z0-9]{24,}' \
    'gh[pousr]_[A-Za-z0-9]{20,}' \
    'github_pat_[A-Za-z0-9_]{20,}' \
    'AKIA[0-9A-Z]{16}' \
    'Bearer [A-Za-z0-9._-]{24,}'
}

# The replacement text. Contains no quote, backslash or & so it is safe as a sed
# replacement AND inside a JSON string - review.json is redacted with this filter
# and has to stay parseable afterwards.
rv2_redaction_marker() { printf '%s' '[redacted-credential]'; }

# stdin -> stdout, with every live credential VALUE and every credential SHAPE
# replaced by the marker. A TEXT filter: it reads lines, so it is for logs and
# JSON, not for binaries.
#
# Exact values are replaced in bash rather than with sed because the value is
# arbitrary bytes and building a sed program out of it means escaping it
# correctly every time; `${line//"$v"/...}` is literal by construction. The shape
# pass is one sed because those patterns are ours.
rv2_redact_stream() {
  local mark v val line p
  local vals=() seds=()
  mark="$(rv2_redaction_marker)"
  while IFS= read -r v; do
    val="${!v:-}"
    # Short values are not credentials and would match everywhere; an empty one
    # would match every position of every line.
    [ "${#val}" -ge 12 ] && vals+=("$val")
  done < <(rv2_credential_env_names)
  while IFS= read -r p; do
    seds+=(-e "s/$p/$mark/g")
  done < <(rv2_credential_patterns)
  {
    if [ "${#vals[@]}" -gt 0 ]; then
      # `|| [ -n "$line" ]` so a final line with no newline is not dropped.
      while IFS= read -r line || [ -n "$line" ]; do
        for v in "${vals[@]}"; do line="${line//"$v"/"$mark"}"; done
        printf '%s\n' "$line"
      done
    else
      cat
    fi
  } | sed -E "${seds[@]}"
}

# Dump every pane into the run's logs (and stderr) so a boot failure carries the reason.
#
# Panes are the only place the trunk's and workers' own stderr exists; when boot gave up it
# killed the session and that output was gone for good, which is why the first two failed
# trials had to be re-run to learn anything at all.
#
# THE TWO COPIES HAVE DIFFERENT RETENTION, so they get different treatment.
#
# logs/panes-*.log is uploaded as the run artifact: 7 days, and scan-leaks.sh sweeps it, so a
# credential a worker echoed into a pane is preserved there for forensics AND alarmed on. The
# stderr copy lands in the GitHub Actions log, which is kept for 90 days, is visible to anyone
# who can read the run, and is swept by nothing - so it gets the redacted copy. The pane text a
# human needs in order to see WHY boot failed ("Select login method", a stack trace, a theme
# picker) survives redaction untouched; only the token shapes do not.
rv2_dump_panes() {
  local tag="${1:-failure}" session dir w
  session="$(rv2_session)"
  dir="$(rv2_root)/logs"; mkdir -p "$dir"
  for w in $(tmux list-windows -t "$session" -F '#{window_index}' 2>/dev/null); do
    {
      echo "=== window $w ($tag) ==="
      tmux capture-pane -p -S -200 -t "$session:$w" 2>&1
    } | tee -a "$dir/panes-$tag.log" | rv2_redact_stream >&2
  done
}

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

# Is the pane busy? Every pane is Claude Code now (trunk AND crew), so there is
# one busy signal instead of two: the 'esc to interrupt' footer.
#
# This used to fork on is_pi because pi's only busy marker was 'Working...'.
# Carrying two detectors is how W17 sat idle for a full day locally - the caller
# picked the wrong branch and every poll read "not busy". One role, one check.
rv2_busy() {
  local p
  p="$(rv2_pane "$1")"
  grep -q 'esc to interrupt' <<<"$p"
}

rv2_trunk_busy() { rv2_busy "$(rv2_trunk_index)"; }

# Wait for a pane to reach the Claude Code INPUT BOX, and refuse to type into it
# until it has.
#
# boot used to sleep 12 and start typing. If the pane was on a first-run wizard
# instead, the brief went into a SELECT LIST: measured 2026-08-10 against the
# pinned 2.1.220 binary, the seed line's Enter picked a theme and advanced the
# wizard to its next page. Boot then reported "trunk never accepted its brief",
# which is true and says nothing about why - the screen holding the answer was
# right there in the pane and no one read it before typing over it.
#
# So this waits for a POSITIVE readiness marker, and on timeout names the screen
# it is actually looking at. Failing with "you are on the theme picker" instead
# of "the seed was refused" is the entire point.
rv2_wait_prompt_box() {
  local i="$1" timeout_s="${2:-90}" t p
  for t in $(seq 1 "$timeout_s"); do
    p="$(rv2_pane "$i")"
    case "$p" in
      *"bypass permissions on"*|*"? for shortcuts"*) return 0 ;;
    esac
    sleep 1
  done
  p="$(rv2_pane "$i")"
  # The four first-run screens, in the order a fresh HOME hits them. The fourth
  # is the one CI actually died on (run 31372272415, 2026-08-10) and it was the
  # one missing from this table on the first pass - so the failure fell through
  # to the generic message, which is exactly the defect being fixed here. Its
  # default option is "No, exit": one more blind Enter and the trunk would have
  # shut itself down instead of stalling.
  local gate=''
  case "$p" in
    *"Choose the text style"*)
      gate='the THEME PICKER (first-run screen 1 of 4)' ;;
    *"Press Enter to continue"*)
      gate='the SECURITY NOTES page (first-run screen 2 of 4)' ;;
    *"trust this folder"*|*"Is this a project you created"*)
      gate='the TRUST-THIS-FOLDER dialog (first-run screen 3 of 4)' ;;
    *"Bypass Permissions mode"*|*"Yes, I accept"*)
      gate='the BYPASS PERMISSIONS consent dialog (first-run screen 4 of 4)' ;;
    *"Select login method"*|*"Log in with"*)
      gate='the LOGIN screen - the relay credentials are not being honored' ;;
  esac
  if [ -n "$gate" ]; then
    echo "rv2: pane $i is sitting on $gate, not the input box." >&2
    echo "rv2: anything typed there is keystrokes into a wizard, not a prompt." >&2
    echo "rv2: v2/seed-claude-config.sh clears these before boot - check that it ran," >&2
    echo "rv2: and that the pane's HOME is $(rv2_pane_home)." >&2
  else
    echo "rv2: pane $i never reached the input box within ${timeout_s}s." >&2
  fi
  return 1
}

# Liveness from the process table, never the pane: after a host reboot tmux
# restores each pane's last pre-crash frame, status bar and all, so a dead
# window still *looks* alive.
rv2_alive() {
  local pp
  pp=$(tmux list-panes -t "$(rv2_session):$1" -F '#{pane_pid}' 2>/dev/null | head -1)
  [ -n "$pp" ] || return 1
  # 'fake' covers the deterministic smoke stubs (fake/trunk.sh runs as bash,
  # whose cmdline matches neither claude nor node).
  #
  # 'pi' is deliberately NOT in this alternation any more. Beyond being dead
  # (the crew is cc-review-lite), as a -f regex it matched any command line
  # merely CONTAINING those two letters - a path like /opt/pipeline/x is enough -
  # so a dead pane could read as alive. A liveness check that can be satisfied by
  # an unrelated process is worse than no check: it converts a crash into a hang.
  #
  # DESCENDANTS, not `pgrep -P`. -P matches DIRECT children only, and the real
  # tree is pane shell -> shell -> claude, so a live trunk read as dead: on
  # 2026-08-10 boot printed "trunk pane never came alive" while the trunk was
  # visibly mid-turn, and wait-review then used the same check to kill a review
  # that was working. A liveness test that answers "is my immediate child still
  # there" breaks the moment anything wraps the process in a shell - which is
  # exactly what the launch line does.
  rv2_descendant_matches "$pp" 'claude|node|fake'
}

# Is any DESCENDANT of $1 running a command line matching $2?
#
# Deliberately not clever: find candidates by pattern, then walk each one's ppid
# chain upward looking for the root. Going up is bounded and needs no tree
# building; going down needs a full table and a fixpoint loop, and the version
# that did got both directions wrong on the first try.
# /proc/PID/stat field 4 is the ppid, but field 2 is the command name in
# parentheses and MAY CONTAIN SPACES, which shifts every positional field after
# it. Cut at the last ')' before counting. patrol.sh's pi_alive_under takes
# field 4 directly and gets away with it because pi and node have space-free
# names; that is a property of the processes, not of the parser.
rv2_ppid_of() {
  local s
  s=$(cat "/proc/$1/stat" 2>/dev/null) || return 1
  s=${s##*') '}            # drop "pid (comm) " - greedy, so a ')' in comm is safe
  printf '%s\n' "$s" | awk '{print $2}'   # state is now $1, ppid is $2
}

rv2_descendant_matches() {
  local root="$1" pattern="$2" cand up n
  [ -n "$root" ] || return 1
  for cand in $(pgrep -f "$pattern" 2>/dev/null); do
    [ "$cand" = "$root" ] && continue
    up="$cand"; n=0
    while [ -n "$up" ] && [ "$up" != "1" ] && [ "$n" -lt 30 ]; do
      up=$(rv2_ppid_of "$up") || break
      [ "$up" = "$root" ] && return 0
      n=$((n + 1))
    done
  done
  return 1
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
# The third argument used to be is_pi, and it is REMOVED rather than ignored so
# a stale `rv2_wait_idle "$i" 60 1` fails loudly instead of quietly checking the
# wrong pane. Worth removing on its own: the old default (0) routed to
# rv2_trunk_busy, which ignores pane_index entirely, so any worker wait that
# omitted the flag would have polled the TRUNK's footer. No caller did - the one
# live call site passed 1 explicitly - but the trap outlived the reason for it.
rv2_wait_idle() {
  local pane_index="$1" timeout_s="${2:-60}"
  local i
  for i in $(seq 1 "$((timeout_s / 3))"); do
    rv2_busy "$pane_index" || return 0
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
