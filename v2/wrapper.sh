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

if command -v jq >/dev/null 2>&1; then
  echo "wrapper: review.json valid - decision=$(jq -r .decision "$REVIEW") findings=$(jq -r '.findings|length' "$REVIEW") failures=$(jq -r '.failures|length' "$REVIEW")"
else
  echo "wrapper: review.json valid"
fi
