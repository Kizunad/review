#!/usr/bin/env bash
# Scan everything the crew produced for credential-shaped strings and RAISE AN
# ALARM. Operator ruling 2026-08-10: the relay node is ours, so probe mode does
# not get key isolation or a separate quota - detection on the output side is
# enough, and a hit is a warning, NOT a block.
#
# That ruling is the whole design of SWEEP MODE: it never changes a decision and
# never exits nonzero on a hit. A review that is otherwise sound must not be
# thrown away because a worker was careless with an echo; someone needs to be
# told, that is all.
#
# The ruling was made about the RUN ARTIFACT, which GitHub keeps for 7 days and
# which only someone with access to the run can download. It is NOT extended to
# the pull request comment - see REDACT MODE below.
#
# IT MUST NEVER PRINT WHAT IT FINDS. A scanner that echoes the secret into the
# CI log has moved it somewhere with LONGER retention than the artifact it was
# protecting - the report gives file, line, and a short prefix, never the match.
#
# Two detectors, because they fail in opposite directions:
#   1. exact - the live relay token. No false negatives for the one credential
#      this job actually holds, whatever shape it has.
#   2. shape - sk-/ah-/gh*/AKIA/Bearer patterns, for tokens that came from
#      somewhere else and whose value we do not know.
# Both lists live in v2/lib.sh (rv2_credential_env_names / rv2_credential_
# patterns) because the pane-dump redactor needs the same ones and two copies
# would drift.
#
# Usage:
#   v2/scan-leaks.sh [root]           SWEEP: alarm on the state root, exit 0.
#   v2/scan-leaks.sh --redact FILE    REDACT: strip credential-shaped strings out
#                                     of a file that is about to be PUBLISHED.
# Exit:  always 0 unless the root/file is missing (64) or the rewrite failed (70).
#        Hits go to stderr and to logs/leak-scan.txt.
set -uo pipefail

V2_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=v2/lib.sh
. "$V2_DIR/lib.sh"

# NEVER -I. -I makes grep classify a file as binary and SKIP IT ENTIRELY, and a
# crew log needs exactly one NUL byte to earn that classification - a stray
# control character in a test's output, a captured pane from a TUI, a truncated
# write. The file then ships in the artifact unscanned while the scanner reports
# "clean", which is the worst failure a detector has: silently excluding a class
# of the thing it was sent to find.
#
# -o instead of printing the line, so treating binaries as text cannot hand a
# multi-megabyte NUL-free "line" to the reporting loop, and so the match is
# already isolated (the old code re-grepped the line to recover it).
GREP_BASE=(-r -a -n -o)

report_line() { # file line prefix why  -> the report format, value withheld
  printf '%s:%s  %s...  %s\n' "$1" "$2" "$3" "$4"
}

# ---------------------------------------------------------------- REDACT MODE
#
# review.md is rendered from output/review.json by harness/publish-artifact.mjs
# and is posted VERBATIM as a pull request comment by the privileged write job.
# Sweep mode ran before that file was even built, and alarmed rather than acted,
# so a worker that recorded `curl -H "Authorization: Bearer $ANTHROPIC_AUTH_
# TOKEN" ...` as an evidence command got that command rendered into review.md
# and published on a possibly-public pull request - permanently, with no
# retention limit and no access control, which is a different object from the
# 7-day artifact the alarm-not-block ruling was about.
#
# So this path ACTS. It does not throw the review away - that would be the same
# mistake in the other direction, discarding a sound verdict over a careless
# echo - it removes the value and publishes the rest. review.md is a pure
# function of this file, so redacting the source redacts the comment.
if [ "${1:-}" = "--redact" ]; then
  TARGET="${2:-}"
  [ -n "$TARGET" ] && [ -f "$TARGET" ] || {
    echo "scan-leaks: --redact needs an existing file (got '${TARGET:-}')" >&2; exit 64; }
  ROOT="$(rv2_root)"
  REPORT="$ROOT/logs/leak-scan.txt"
  mkdir -p "$ROOT/logs"

  # Count before rewriting so the message can say how many and whether the LIVE
  # credential was among them - "rotate the key" and "fix the worker brief" are
  # different instructions and must not be issued as one.
  exact_n=0
  shape_n=0
  while IFS= read -r var; do
    val="${!var:-}"
    [ "${#val}" -ge 12 ] || continue
    n="$(grep -oaF -e "$val" "$TARGET" 2>/dev/null | wc -l)"
    exact_n=$((exact_n + n))
  done < <(rv2_credential_env_names)
  while IFS= read -r pat; do
    n="$(grep -oaE -e "$pat" "$TARGET" 2>/dev/null | wc -l)"
    shape_n=$((shape_n + n))
  done < <(rv2_credential_patterns)

  if [ "$((exact_n + shape_n))" -eq 0 ]; then
    echo "scan-leaks: publish gate clean - $TARGET carries no credential-shaped string"
    exit 0
  fi

  tmp="$(mktemp)" || { echo "scan-leaks: mktemp failed" >&2; exit 70; }
  trap 'rm -f "$tmp"' EXIT
  rv2_redact_stream <"$TARGET" >"$tmp" || {
    echo "scan-leaks: redaction of $TARGET FAILED - refusing to leave it half-rewritten" >&2
    exit 70; }
  # cat, not mv: keep the original file's inode and mode rather than mktemp's.
  cat "$tmp" >"$TARGET" || {
    echo "scan-leaks: could not write the redacted $TARGET" >&2; exit 70; }

  report_line "$TARGET" 0 "$(rv2_redaction_marker)" \
    "REDACTED before publication: $exact_n exact + $shape_n shape" >>"$REPORT"
  {
    echo "scan-leaks: PUBLISH GATE - redacted $((exact_n + shape_n)) credential-shaped string(s)"
    echo "scan-leaks: from $TARGET (values withheld; $exact_n were the live credential)."
    echo "scan-leaks: review.md is rendered from this file and posted verbatim as a PR comment,"
    echo "scan-leaks: which is permanent and possibly public - the 2026-08-10 alarm-not-block"
    echo "scan-leaks: ruling was made about a 7-day artifact and is not extended to it. The"
    echo "scan-leaks: review still publishes; only the value is gone."
    [ "$exact_n" -gt 0 ] && echo "scan-leaks: ROTATE THE RELAY KEY - the live credential was in the payload."
  } >&2
  [ -n "${GITHUB_STEP_SUMMARY:-}" ] && {
    echo "### leak scan: redacted $((exact_n + shape_n)) credential-shaped string(s) from the published review"
    echo "The review is published; the values are not. $exact_n were the live credential."
  } >>"$GITHUB_STEP_SUMMARY"
  exit 0
fi

# ----------------------------------------------------------------- SWEEP MODE
ROOT="${1:-$(rv2_root)}"
[ -d "$ROOT" ] || { echo "scan-leaks: no state root at $ROOT" >&2; exit 64; }
REPORT="$ROOT/logs/leak-scan.txt"
mkdir -p "$ROOT/logs"
: >"$REPORT"

# SCAN THE WHOLE STATE ROOT, minus the one thing that is not crew output.
#
# This was a hand-maintained list of six directories, and it had ALREADY
# diverged from the upload set: checkpoint/ and ledger.tsv are uploaded as
# artifacts and were not being scanned. A leak scanner whose target list is
# narrower than what leaves the machine is the same defect as a detector that
# excludes the class it was sent to find - and the second list is what makes it
# happen, because nobody updates two lists.
#
# So there is one list, and it is an EXCLUSION: repo/ is the checkout of the
# repository under review. It is excluded because it is not crew output and
# because any credential shape in it belongs to the PR author's code, not to a
# worker being careless - and because prepare-repo.sh puts a whole Bong tree
# there, which is why the artifact upload enumerates paths in the first place.
# Anything else written under the root is scanned by default, including
# directories that do not exist yet.
GREP_EXCLUDES=(--exclude-dir=repo --exclude-dir=.git --exclude="$(basename "$REPORT")")
REPO_DIR="$ROOT/repo"

# Hits are collected first and classified second - see PROVENANCE below.
H_FILE=(); H_LINE=(); H_MATCH=(); H_WHY=(); H_KIND=()
add_hit() { H_FILE+=("$1"); H_LINE+=("$2"); H_MATCH+=("$3"); H_WHY+=("$4"); H_KIND+=("$5"); }

# 1. Exact: the credential this job is actually holding.
#    Skipped when unset (fake mode) rather than matching the empty string, which
#    would match every line of every file.
while IFS= read -r var; do
  val="${!var:-}"
  [ "${#val}" -ge 12 ] || continue
  while IFS=: read -r f n m; do
    [ -n "$f" ] || continue
    add_hit "$f" "$n" "$m" "exact match of \$$var" exact
  done < <(grep "${GREP_BASE[@]}" -F -e "$val" "$ROOT" "${GREP_EXCLUDES[@]}" 2>/dev/null)
done < <(rv2_credential_env_names)

# 2. Shape: tokens whose value we do not know.
while IFS= read -r pat; do
  while IFS=: read -r f n m; do
    [ -n "$f" ] || continue
    add_hit "$f" "$n" "$m" "credential-shaped string" shape
  done < <(grep "${GREP_BASE[@]}" -E -e "$pat" "$ROOT" "${GREP_EXCLUDES[@]}" 2>/dev/null)
done < <(rv2_credential_patterns)

# PROVENANCE: does this string come from the pull request's own code?
#
# --exclude-dir=repo was written as if the checkout were the only place the PR's
# text lands under the root. It is not. rv2_pane_home is $ROOT/home, which is not
# excluded and cannot be: Claude Code writes full session transcripts there, and
# a transcript is EXACTLY where a leaked credential would land - a worker that
# echoes the token has it in its transcript whether or not it also has it in a
# log. But a transcript also quotes the files the crew read, so a PR that merely
# contains an SDK fixture string ("sk-ant-api03-...") produced a shape hit on
# EVERY run, in the step summary. An alarm that fires on every clean run is an
# alarm nobody reads, and the run where it means something looks identical.
#
# The discriminator is not WHERE the string was found, it is WHETHER THE SAME
# STRING IS IN THE REPOSITORY UNDER REVIEW. If it is, the PR author already has
# it and already published it in their own diff; it is their string, not our
# leak. If it is not, something in this job produced it and it is loud, no matter
# which file it turned up in. So transcripts stay scanned and stay noisy only for
# strings that are genuinely new.
#
# An exact match of a live credential is NEVER downgraded. If our relay token is
# sitting in the PR's source tree, that is worse than a leak, not a false alarm.
declare -A TIER=()
PROVENANCE_BUDGET=64      # distinct values, not hits; beyond this, stay loud
provenance_checks=0

# Answers into a global rather than onto stdout ON PURPOSE: `$(tier_of ...)` runs
# in a SUBSHELL, so the memo table and the budget counter would be discarded on
# every call and the repo tree would be re-grepped once per hit - which on a
# transcript that quotes a fixture 400 times is 400 full-tree greps.
TIER_RESULT=
tier_of() { # match -> TIER_RESULT=leak|repo   (memoized per distinct value)
  local m="$1"
  if [ -n "${TIER[$m]:-}" ]; then TIER_RESULT="${TIER[$m]}"; return 0; fi
  TIER_RESULT=leak
  if [ -d "$REPO_DIR" ] && [ "$provenance_checks" -lt "$PROVENANCE_BUDGET" ]; then
    provenance_checks=$((provenance_checks + 1))
    if grep -raqF -e "$m" "$REPO_DIR" 2>/dev/null; then TIER_RESULT=repo; fi
  fi
  TIER[$m]="$TIER_RESULT"
}

hits=0            # loud: what ALARM counts, and what the step summary shows
repo_hits=0       # quiet: recorded in the report, never alarmed
LOUD=()
i=0
while [ "$i" -lt "${#H_FILE[@]}" ]; do
  m="${H_MATCH[$i]}"
  TIER_RESULT=leak
  [ "${H_KIND[$i]}" = shape ] && tier_of "$m"
  if [ "$TIER_RESULT" = repo ]; then
    report_line "${H_FILE[$i]}" "${H_LINE[$i]}" "${m:0:6}" \
      "shape, but present in the repository under review - the PR's own text, not alarmed" >>"$REPORT"
    repo_hits=$((repo_hits + 1))
  else
    line="$(report_line "${H_FILE[$i]}" "${H_LINE[$i]}" "${m:0:6}" "${H_WHY[$i]}")"
    printf '%s\n' "$line" | tee -a "$REPORT" >&2
    LOUD+=("$line")
    hits=$((hits + 1))
  fi
  i=$((i + 1))
done

if [ "$hits" -gt 0 ]; then
  {
    echo "scan-leaks: ALARM - $hits credential-shaped string(s) in crew output (details above, values withheld)"
    echo "scan-leaks: this does NOT block the review (operator ruling: the relay node is ours)."
    echo "scan-leaks: rotate the relay key if an exact match was reported, and fix the worker brief."
  } >&2
  # A GitHub annotation so the hit is visible on the run without opening the
  # artifact - still no value in it, and ONLY the loud hits: putting the
  # repo-origin lines here is how the summary became wallpaper.
  [ -n "${GITHUB_STEP_SUMMARY:-}" ] && {
    echo "### leak scan: $hits credential-shaped string(s) found (values withheld, review not blocked)"
    printf '    %s\n' "${LOUD[@]}"
  } >>"$GITHUB_STEP_SUMMARY"
else
  echo "scan-leaks: clean - no credential-shaped strings in crew output"
fi
if [ "$repo_hits" -gt 0 ]; then
  # stderr, not the step summary: worth having in the log so the downgrade is
  # never invisible, not worth a banner on a run that is behaving normally.
  echo "scan-leaks: $repo_hits shape hit(s) matched text that is also in the repository under review" >&2
  echo "scan-leaks: (the pull request's own strings, e.g. a fixture key quoted in a transcript);" >&2
  echo "scan-leaks: recorded in logs/leak-scan.txt, not alarmed." >&2
fi
exit 0
