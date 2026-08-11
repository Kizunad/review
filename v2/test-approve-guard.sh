#!/usr/bin/env bash
# An approve must not outlive a blocked crew.
#
# THE RUN THIS EXISTS FOR: Bong 31456996236, published to PR 2042. Two of three shards reported
# verdict=blocked - s-1's notes read "Ran 0 tests and NO TESTS RAN (exit code 5). Therefore no
# executable result was established" - and the trunk returned approve, findings [], failures [].
# The signal was already machine-readable in a field the evidence contract already defines, and
# nothing read it.
#
# Both directions are asserted, and they are not symmetric:
#   a missed block  -> a PR merges on a review that verified nothing
#   a false block   -> a legitimate approve is downgraded to a retryable infra failure, costing
#                      one re-run and no correctness
# So the guard fails CLOSED on anything that is not an explicit pass, including a MISSING field.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$1"; }

command -v jq >/dev/null 2>&1 || { echo "jq required"; exit 2; }

run_case() { # name decision verdicts... -> prints resulting decision
  local root; root="$(mktemp -d)"
  mkdir -p "$root/evidence" "$root/output" "$root/assignments"
  local decision="$1"; shift
  printf '[' >"$root/assignments/assignments.json"
  local n=0
  for _ in "$@"; do
    [ "$n" -gt 0 ] && printf ',' >>"$root/assignments/assignments.json"
    printf '{"id":"s-%s","kind":"testable"}' "$n" >>"$root/assignments/assignments.json"
    n=$((n+1))
  done
  printf ']' >>"$root/assignments/assignments.json"
  local i=0
  for v in "$@"; do
    if [ "$v" = "__novfield__" ]; then
      printf '{"assignmentId":"s-%s","mode":"test"}\n' "$i" >"$root/evidence/s-$i.json"
    else
      printf '{"assignmentId":"s-%s","mode":"test","verdict":"%s"}\n' "$i" "$v" >"$root/evidence/s-$i.json"
    fi
    i=$((i+1))
  done
  printf '{"version":"v2r1","decision":"%s","headOid":"%s","findings":[],"failures":[],"degradations":[],"resumedFrom":null}\n' \
    "$decision" "0000000000000000000000000000000000000000" >"$root/output/review.json"
  # Only the guard block is under test, so the surrounding wrapper machinery (leak scan,
  # validate-review.mjs, synthesize) is stubbed. Copying the logic would make this a second
  # implementation, so the block is EXTRACTED from the shipped file instead.
  local guard; guard="$(mktemp)"
  awk '/^# AN APPROVE MUST NOT OUTLIVE A BLOCKED CREW\./,/^fi$/' "$HERE/wrapper.sh" >"$guard"
  ROOT="$root" REVIEW="$root/output/review.json" bash -c '
    set -uo pipefail
    synth() { printf "%s\n" "SYNTH:$2"; }
    . "$1"
  ' _ "$guard" 2>&1
  rm -rf "$root" "$guard"
}

echo "== an approve with every shard passing survives"
out="$(run_case approve pass pass pass)"
grep -q 'approve stands' <<<"$out" && ok "all-pass approve stands" || bad "all-pass approve stands: $out"

echo
echo "== THE REAL RUN: two blocked, one pass, decision approve"
out="$(run_case approve blocked blocked pass)"
grep -q 'SYNTH:approve refused' <<<"$out" && ok "blocked shards refuse the approve" || bad "blocked shards refuse the approve: $out"
grep -q 's-0=blocked' <<<"$out" && ok "the refusal NAMES which shard" || bad "the refusal names which shard: $out"

echo
echo "== fail CLOSED on a missing or unreadable verdict"
out="$(run_case approve pass __novfield__)"
grep -q 'SYNTH:approve refused' <<<"$out" && ok "missing verdict blocks" || bad "missing verdict blocks: $out"
grep -q 'missing' <<<"$out" && ok "and says the field was missing" || bad "and says the field was missing: $out"
out="$(run_case approve fail)"
grep -q 'SYNTH:approve refused' <<<"$out" && ok "verdict=fail blocks" || bad "verdict=fail blocks: $out"

echo
echo "== only approve is gated - a refusal on partial evidence is still a refusal"
out="$(run_case request_changes blocked blocked)"
grep -q 'SYNTH:' <<<"$out" && bad "request_changes must NOT be rewritten: $out" || ok "request_changes with blocked shards is left alone"
out="$(run_case infrastructure_failure blocked)"
grep -q 'SYNTH:' <<<"$out" && bad "infrastructure_failure must NOT be rewritten: $out" || ok "infrastructure_failure is left alone"

echo
echo "== no evidence at all must not read as nothing-to-object-to"
root="$(mktemp -d)"; mkdir -p "$root/evidence" "$root/output" "$root/assignments"
printf '[{"id":"s-0","kind":"testable"},{"id":"s-1","kind":"testable"}]' >"$root/assignments/assignments.json"
printf '{"version":"v2r1","decision":"approve","headOid":"%s","findings":[],"failures":[],"degradations":[],"resumedFrom":null}\n' \
  0000000000000000000000000000000000000000 >"$root/output/review.json"
guard="$(mktemp)"; awk '/^# AN APPROVE MUST NOT OUTLIVE A BLOCKED CREW\./,/^fi$/' "$HERE/wrapper.sh" >"$guard"
out="$(ROOT="$root" REVIEW="$root/output/review.json" bash -c 'set -uo pipefail; synth(){ printf "%s\n" "SYNTH:$2"; }; . "$1"' _ "$guard" 2>&1)"
rm -rf "$root" "$guard"
# This was a KNOWN GAP for about five minutes: the per-shard loop finds no files and therefore
# no blocks, so silence sailed through - the same vacuous-predicate shape as the approve rule
# itself, one level down. Closed by counting before looping. Asserted rather than noted, because
# a gap recorded in a comment is the thing this whole file is a reaction to.
grep -q 'SYNTH:approve refused' <<<"$out" && ok "an empty evidence dir is refused" \
  || bad "an empty evidence dir is refused: $out"
grep -q '0 evidence file' <<<"$out" && ok "and says how many were missing" \
  || bad "and says how many were missing: $out"

printf '\n%s: %d passed, %d failed\n' "$(basename "$0")" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
