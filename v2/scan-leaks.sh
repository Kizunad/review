#!/usr/bin/env bash
# Scan everything the crew produced for credential-shaped strings and RAISE AN
# ALARM. Operator ruling 2026-08-10: the relay node is ours, so probe mode does
# not get key isolation or a separate quota - detection on the output side is
# enough, and a hit is a warning, NOT a block.
#
# That ruling is the whole design here: this script never changes a decision and
# never exits nonzero on a hit. A review that is otherwise sound must not be
# thrown away because a worker was careless with an echo; someone needs to be
# told, that is all.
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
#
# Usage: v2/scan-leaks.sh [root]     (root defaults to the harness state root)
# Exit:  always 0 unless the root is missing. Hits go to stderr and to
#        logs/leak-scan.txt.
set -uo pipefail

V2_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=v2/lib.sh
. "$V2_DIR/lib.sh"

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

hits=0

# Report a hit WITHOUT the value: path, line number, and the first 6 characters
# of the match so a human can tell an sk- from an ah- without being handed either.
report() { # file line prefix why
  printf '%s:%s  %s...  %s\n' "$1" "$2" "$3" "$4" | tee -a "$REPORT" >&2
  hits=$((hits + 1))
}

# 1. Exact: the credential this job is actually holding.
#    Skipped when unset (fake mode) rather than matching the empty string, which
#    would match every line of every file.
for var in ANTHROPIC_AUTH_TOKEN ANTHROPIC_API_KEY GITHUB_TOKEN GH_TOKEN; do
  val="${!var:-}"
  [ ${#val} -ge 12 ] || continue
  while IFS=: read -r f n _; do
    [ -n "$f" ] || continue
    report "$f" "$n" "${val:0:6}" "exact match of \$$var"
  done < <(grep -rIn -F -e "$val" "$ROOT" "${GREP_EXCLUDES[@]}" 2>/dev/null)
done

# 2. Shape: tokens whose value we do not know.
#    ah- is the AxonHub relay's own prefix; the rest are the common vendors.
PATTERNS=(
  'sk-[A-Za-z0-9_-]{16,}'
  'ah-[A-Za-z0-9]{24,}'
  'gh[pousr]_[A-Za-z0-9]{20,}'
  'github_pat_[A-Za-z0-9_]{20,}'
  'AKIA[0-9A-Z]{16}'
  'Bearer [A-Za-z0-9._-]{24,}'
)
for pat in "${PATTERNS[@]}"; do
  while IFS=: read -r f n rest; do
    [ -n "$f" ] || continue
    m="$(grep -oE "$pat" <<<"$rest" | head -1)"
    report "$f" "$n" "${m:0:6}" "credential-shaped string"
  done < <(grep -rIn -E -e "$pat" "$ROOT" "${GREP_EXCLUDES[@]}" 2>/dev/null)
done

if [ "$hits" -gt 0 ]; then
  {
    echo "scan-leaks: ALARM - $hits credential-shaped string(s) in crew output (details above, values withheld)"
    echo "scan-leaks: this does NOT block the review (operator ruling: the relay node is ours)."
    echo "scan-leaks: rotate the relay key if an exact match was reported, and fix the worker brief."
  } >&2
  # A GitHub annotation so the hit is visible on the run without opening the
  # artifact - still no value in it.
  [ -n "${GITHUB_STEP_SUMMARY:-}" ] && {
    echo "### leak scan: $hits credential-shaped string(s) found (values withheld, review not blocked)"
    sed 's/^/    /' "$REPORT"
  } >>"$GITHUB_STEP_SUMMARY"
else
  echo "scan-leaks: clean - no credential-shaped strings in crew output"
fi
exit 0
