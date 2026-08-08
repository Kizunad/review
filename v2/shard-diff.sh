#!/usr/bin/env bash
# Deterministic per-file sharding of a PR diff into review assignments, ported
# from src/diff-sharder.mjs (same split + oversized-section chunking rules).
#
# The trunk calls this once at loop start; it is orchestration tooling, not a
# judgment, so it is deterministic and needs no model. Sharding runs in node so
# it shares the exact regex/behavior of the engine's own sharder.
#
# Output: $RV2_ORCH/assignments.json
#   [ {"id":"s-0","paths":["..."],"chars":123,"kind":"testable|skip"}, ... ]
#   kind=testable for script/knowledge paths (P1 test mode); kind=skip for
#   lockfiles, vendor, and non-script paths that P1 does not contract-test.
#
# Usage: v2/shard-diff.sh <diff-file> [max-chars]
#   Env: RV2_ORCH (default _orch), RV2_MAX_SHARD_CHARS (default 12000, aligned
#   with the v1 max_shard_chars default).
set -euo pipefail

V2_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=v2/lib.sh
. "$V2_DIR/lib.sh"

DIFF_FILE="${1:?usage: v2/shard-diff.sh <diff-file> [max-chars]}"
[ -f "$DIFF_FILE" ] || { echo "shard-diff: no diff file at $DIFF_FILE" >&2; exit 1; }
MAX_CHARS="${2:-${RV2_MAX_SHARD_CHARS:-12000}}"
OUT="$(rv2_root)/assignments/assignments.json"
mkdir -p "$(rv2_root)/assignments"

node --input-type=module - "$DIFF_FILE" "$MAX_CHARS" "$OUT" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';

const [diffFile, maxCharsRaw, outFile] = process.argv.slice(2);
const maxChars = Number(maxCharsRaw);
const diff = readFileSync(diffFile, 'utf8');
const sections = diff.split(/(?=^diff --git )/m).filter(Boolean);

const TESTABLE = /\.(sh|bash|mjs|js|ts|py|rb|pl|json|ya?ml|toml|md|txt|rs|java|kts)$/i;
const SKIP = /(^|\/)(lock|package-lock|Cargo\.lock|pnpm-lock|yarn\.lock|\.env|\.gitignore)$|\bvendor\b|\bbinary\b/;

const assignments = [];
for (const section of sections) {
  const header = section.split('\n', 1)[0];
  const match = /^diff --git a\/(.+) b\/(.+)$/.exec(header);
  const path = match?.[2] ?? null;
  const len = section.length;
  if (len <= maxChars) {
    assignments.push({ id: `s-${assignments.length}`, paths: path ? [path] : [], chars: len });
  } else {
    for (let offset = 0; offset < len; offset += maxChars) {
      assignments.push({
        id: `s-${assignments.length}`,
        paths: path ? [path] : [],
        chars: Math.min(maxChars, len - offset),
      });
    }
  }
}

const annotated = assignments.map((a) => {
  const path = a.paths[0] ?? '';
  const kind = path === '' || SKIP.test(path) ? 'skip' : (TESTABLE.test(path) ? 'testable' : 'skip');
  return { ...a, kind };
});

writeFileSync(outFile, `${JSON.stringify(annotated, null, 2)}\n`);
NODE
if command -v jq >/dev/null 2>&1; then
  echo "shard-diff: $(jq 'length' "$OUT") assignments -> $OUT"
else
  echo "shard-diff: $OUT"
fi
