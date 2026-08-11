#!/usr/bin/env bash
# Deterministic wrapper step (design 5.5): validates the trunk's review.json
# against the v2r1 contract (harness/validate-review.mjs) + the authoritative
# headOid + the evidence cross-check, and converts trunk death/timeout into
# decision=infrastructure_failure. Plain bash + node - no model, no judgment -
# so this step runs on trunk failure (if: always()) without inheriting it.
set -euo pipefail

V2_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=v2/lib.sh
. "$V2_DIR/lib.sh"

ROOT="$(rv2_root)"
OUT="$(rv2_output)"
mkdir -p "$OUT"
REVIEW="$OUT/review.json"

head_oid="$(rv2_head_oid)"
[ -n "$head_oid" ] || { echo "wrapper: HEAD_OID required" >&2; exit 64; }
export HEAD_OID="$head_oid"
export HARNESS_DIR="$ROOT"

# A final checkpoint so the artifact set is never stale.
"$V2_DIR/checkpoint.sh" >/dev/null 2>&1 || true

# Leak scan BEFORE the review.json branches below, because every one of them
# exits: a run whose trunk died still uploaded whatever the crew wrote, and that
# is exactly the run nobody reads carefully. Never gated on the decision, and it
# cannot fail the step - a hit is an alarm, not a block (operator, 2026-08-10).
"$V2_DIR/scan-leaks.sh" "$ROOT" || true

# ...and then a SECOND pass over the one file that does not stay in the artifact.
#
# The sweep above alarms. That ruling was made about the 7-day run artifact. This
# file is different: harness/publish-artifact.mjs renders review.md from it and
# the privileged write job posts that markdown VERBATIM as a pull request
# comment - permanent, possibly public, no retention limit, readable by anyone
# who can see the PR. A crew worker that recorded
# `curl -H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN" ...` as an evidence
# command had that command rendered into review.md and published, and nothing on
# this path ever looked at it: the sweep ran before _publish existed, and would
# only have warned anyway.
#
# So the payload is redacted, not alarmed and not discarded - the review still
# publishes, minus the value. It runs BEFORE validation on purpose: if a
# redaction ever produced something that is not valid v2r1, the branch below
# parks it as review.invalid.json instead of publishing it.
if [ -f "$REVIEW" ]; then
  "$V2_DIR/scan-leaks.sh" --redact "$REVIEW" || true
fi

synth() { # stage error
  local stage="$1" err="$2"
  echo "wrapper: $stage - $err"
  local resumed=""
  [ -f "$ROOT/resume/resumed-from.txt" ] && resumed="$(cat "$ROOT/resume/resumed-from.txt" 2>/dev/null || true)"
  RESUMED_FROM="$resumed" node "$V2_DIR/../harness/validate-review.mjs" synthesize "$stage" "$err" >"$REVIEW"
}

if [ ! -f "$REVIEW" ]; then
  synth "trunk" "trunk produced no review.json (died or timed out)"
  exit 0
fi

if ! node "$V2_DIR/../harness/validate-review.mjs" validate "$REVIEW" >/dev/null 2>&1; then
  mv "$REVIEW" "$OUT/review.invalid.json"
  synth "trunk" "review.json failed v2r1 validation (parked as review.invalid.json)"
  exit 0
fi

# AN APPROVE MUST NOT OUTLIVE A BLOCKED CREW.
#
# 2026-08-11, Bong run 31456996236, published to PR 2042 before anyone noticed. Two of three
# crew shards reported verdict=blocked - s-1's own notes read "Ran 0 tests and NO TESTS RAN
# (exit code 5). Therefore no executable result was established" - and the trunk returned
# decision=approve, findings [], failures []. It was published as a real review comment.
#
# THE SIGNAL WAS ALREADY THERE, MACHINE-READABLE, IN A FIELD THE CONTRACT ALREADY DEFINES.
# The crew did everything right: it wrote the test, hit an invocation error, recorded
# verdict=blocked, and said so in prose. Nothing read the field. That is worse than an
# undocumented defect, because the evidence file looks complete and the verdict looks clean.
#
# Why the check is HERE and not in the trunk prompt: the trunk is the component that just
# failed this, and asking it to grade its own inputs is the same trust that produced the
# approve. This is jq over files on disk.
#
# Why the approve becomes infrastructure_failure rather than request_changes: a blocked shard
# is a harness that could not run, not a defect in the PR. Turning it into request_changes
# would send an author to fix something nobody demonstrated. infrastructure_failure is
# retryable, never a merge signal, and honest about whose fault it is. When the
# needs_more_evidence exit exists (reports/DESIGN-V2-STAGED-JOBS.md 4.6) this becomes that
# instead, and the difference will matter for attempt accounting.
#
# Only `approve` is gated. A request_changes standing on partial evidence is still a refusal
# to merge, so it fails safe already, and downgrading it would suppress real findings.
if command -v jq >/dev/null 2>&1; then
  decision="$(jq -r .decision "$REVIEW")"
  echo "wrapper: review.json valid - decision=$decision findings=$(jq -r '.findings|length' "$REVIEW") failures=$(jq -r '.failures|length' "$REVIEW")"
  if [ "$decision" = approve ]; then
    blocked=""
    # AN EMPTY EVIDENCE DIRECTORY IS NOT "NOTHING TO OBJECT TO".
    # The loop below finds no files and therefore no blocks, so silence would sail through the
    # verdict-per-shard check on its own. That is the same vacuous-predicate shape as the approve
    # rule itself ("every finding is minor" being true for zero findings), one level down, and it
    # fires on exactly the runs where the crew produced nothing at all: a failed checkout, a
    # missing dependency, a harness that never started. So COUNT first.
    want="$(jq -r 'length' "$ROOT/assignments/assignments.json" 2>/dev/null || echo "")"
    have="$(find "$ROOT/evidence" -maxdepth 1 -name '*.json' 2>/dev/null | wc -l)"
    if [ -z "$want" ]; then
      synth "evidence" "approve refused: assignments.json unreadable, so evidence completeness cannot be established"
      exit 0
    fi
    if [ "$have" -lt "$want" ]; then
      synth "evidence" "approve refused: $have evidence file(s) for $want assignment(s) - $((want - have)) shard(s) left no evidence at all"
      exit 0
    fi
    for ev in "$ROOT"/evidence/*.json; do
      [ -f "$ev" ] || continue
      v="$(jq -r '.verdict // "missing"' "$ev" 2>/dev/null || echo unreadable)"
      case "$v" in
        pass) ;;
        # missing / unreadable / anything not pass counts as blocked. Fail CLOSED: the case
        # this exists for is evidence that never established a result, and "the field is absent"
        # is that case, not an exemption from it.
        *) blocked="$blocked $(basename "$ev" .json)=$v" ;;
      esac
    done
    if [ -n "$blocked" ]; then
      synth "evidence" "approve refused: crew evidence is not all pass -$blocked"
      exit 0
    fi
    echo "wrapper: approve stands - every crew evidence file reports verdict=pass"
  fi
else
  echo "wrapper: review.json valid"
fi
