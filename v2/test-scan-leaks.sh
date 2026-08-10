#!/usr/bin/env bash
# Regression suite for the v2 credential-containment path.
#
# WHY THIS EXISTS
#
# Four defects, all of the same family: a guard that reports success while doing
# nothing. They were found by an adversarial reviewer on 2026-08-10, and none of
# them is visible in a happy-path run - every one of them makes the pipeline look
# CLEANER than it is.
#
#   S18a  scan-leaks.sh ran `grep -rIn`. -I makes grep classify a file as binary
#         and SKIP it, so one NUL byte anywhere in a crew log made that log
#         invisible to the scanner while it still shipped in the artifact.
#   S18b  --exclude-dir=repo assumed the PR's text only lands in the checkout.
#         rv2_pane_home is $ROOT/home and holds Claude Code session transcripts,
#         which quote the files the crew read - so any PR carrying a fixture key
#         produced a shape hit in the step summary on EVERY run, which is how an
#         alarm becomes wallpaper.
#   S10   review.md is rendered from output/review.json and posted VERBATIM as a
#         pull request comment. The sweep ran before that file existed and only
#         warned anyway; and rv2_dump_panes copied pane text to stderr, i.e. into
#         the 90-day CI log, which nothing sweeps.
#   S19   seed-claude-config.sh used `jq ... >tmp && mv`, whose failure `set -e`
#         does not catch, and then "validated" by checking the file still parses
#         - which the untouched original does.
#
# The suite is deliberately hermetic: temp roots, a stub tmux, obviously-fake
# credential shapes, no network, no claude binary. NO REAL CREDENTIAL VALUE
# APPEARS HERE OR IN ANY FIXTURE - the strings below are not tokens for anything.
#
# Usage: v2/test-scan-leaks.sh     (exit non-zero if any case regresses)
set -uo pipefail

V2_DIR="$(cd "$(dirname "$0")" && pwd)"
SCAN="$V2_DIR/scan-leaks.sh"
SEED="$V2_DIR/seed-claude-config.sh"

ok=0
fail=0
ck() { # name expected actual
  if [ "$2" = "$3" ]; then printf 'ok    %s\n' "$1"; ok=$((ok + 1))
  else printf 'FAIL  %s\n        want: %s\n        got : %s\n' "$1" "$2" "$3"; fail=$((fail + 1)); fi
}
ck_has() { # name haystack needle
  case "$2" in
    *"$3"*) printf 'ok    %s\n' "$1"; ok=$((ok + 1)) ;;
    *) printf 'FAIL  %s\n        expected to contain: %s\n        got : %s\n' "$1" "$3" "$2"; fail=$((fail + 1)) ;;
  esac
}
ck_lacks() { # name haystack needle
  case "$2" in
    *"$3"*) printf 'FAIL  %s\n        must NOT contain: %s\n        got : %s\n' "$1" "$3" "$2"; fail=$((fail + 1)) ;;
    *) printf 'ok    %s\n' "$1"; ok=$((ok + 1)) ;;
  esac
}

WORK="$(mktemp -d -t rv2-test-leaks-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

# Fixtures. FAKE_LIVE deliberately matches NO shape pattern, so a hit on it can
# only have come from the exact detector - otherwise the two detectors could
# cover for each other and neither would be under test.
FAKE_LIVE='rv2-fake-not-a-real-credential-0001'
FAKE_SHAPE_LEAK='sk-fakecrewleak000000000000'
FAKE_SHAPE_IN_PR='sk-fakeprfixture0000000000'
OID40='1111111111111111111111111111111111111111'

newroot() { # name -> path; a state root with the directories the harness makes
  local r="$WORK/$1"
  mkdir -p "$r/logs" "$r/evidence" "$r/output" "$r/home/.claude/projects" "$r/repo/src"
  printf '%s' "$r"
}

echo "== S18a: a NUL byte must not hide a file from the scanner =="
R="$(newroot s18a)"
# One NUL byte is all it takes: grep -I calls this file binary and skips it.
printf 'crew ran a test\n\x00\nworker echoed %s and %s\n' "$FAKE_LIVE" "$FAKE_SHAPE_LEAK" \
  >"$R/logs/crew.log"
out="$(ANTHROPIC_AUTH_TOKEN="$FAKE_LIVE" RV2_ROOT="$R" "$SCAN" "$R" 2>&1)"
rc=$?
ck "S18a scan still exits 0 (alarm, not block)" "0" "$rc"
ck_has "S18a the NUL-bearing log is scanned at all" "$out" "logs/crew.log"
ck_has "S18a the live credential is caught by exact match" "$out" 'exact match of $ANTHROPIC_AUTH_TOKEN'
# The prefix, not the bare phrase: "clean - no credential-shaped strings" also
# contains the phrase, so the loose version of this assertion PASSED against the
# broken scanner. An assertion a silent scanner satisfies is the same defect the
# case is about.
ck_has "S18a the unknown token is caught by shape" "$out" "sk-fak...  credential-shaped string"
ck_lacks "S18a the scanner output never carries the value" "$out" "$FAKE_LIVE"
ck_lacks "S18a the scanner output never carries the shaped value" "$out" "$FAKE_SHAPE_LEAK"
ck_lacks "S18a the report file never carries the value" "$(cat "$R/logs/leak-scan.txt")" "$FAKE_LIVE"

echo
echo "== S18b: the PR's own strings in a transcript must not cry wolf =="
R="$(newroot s18b)"
# A routine PR: a fixture key in the source, and Claude Code's session transcript
# quoting the file it read. This is EVERY run on a repo with an SDK fixture.
printf 'const KEY = "%s";\n' "$FAKE_SHAPE_IN_PR" >"$R/repo/src/fixture.js"
printf '{"role":"assistant","text":"src/fixture.js defines %s"}\n' "$FAKE_SHAPE_IN_PR" \
  >"$R/home/.claude/projects/session.jsonl"
SUM="$WORK/summary-s18b.md"; : >"$SUM"
out="$(env -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_API_KEY -u GITHUB_TOKEN -u GH_TOKEN \
       RV2_ROOT="$R" GITHUB_STEP_SUMMARY="$SUM" "$SCAN" "$R" 2>&1)"
rc=$?
ck "S18b exits 0" "0" "$rc"
ck_lacks "S18b a PR fixture quoted in a transcript raises NO alarm" "$out" "ALARM"
ck "S18b nothing is written to the step summary" "0" "$(wc -c <"$SUM" | tr -d ' ')"
ck_has "S18b the downgrade is still recorded in the report" \
  "$(cat "$R/logs/leak-scan.txt")" "present in the repository under review"
ck_has "S18b the report names the transcript it came from" \
  "$(cat "$R/logs/leak-scan.txt")" "home/.claude/projects/session.jsonl"
ck_has "S18b the run still says something rather than going silent" "$out" "clean"

echo
echo "== S18b: a string that is NOT the PR's stays loud, transcript or not =="
R="$(newroot s18b2)"
printf 'const KEY = "%s";\n' "$FAKE_SHAPE_IN_PR" >"$R/repo/src/fixture.js"
# Same file, same directory - only the VALUE differs. The transcript is not
# excluded; that is the point.
printf '{"role":"assistant","text":"I exported %s"}\n' "$FAKE_SHAPE_LEAK" \
  >"$R/home/.claude/projects/session.jsonl"
SUM="$WORK/summary-s18b2.md"; : >"$SUM"
out="$(env -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_API_KEY -u GITHUB_TOKEN -u GH_TOKEN \
       RV2_ROOT="$R" GITHUB_STEP_SUMMARY="$SUM" "$SCAN" "$R" 2>&1)"
ck_has "S18b2 a new credential shape in a transcript IS alarmed" "$out" "ALARM - 1"
ck_has "S18b2 the alarm names the transcript" "$out" "home/.claude/projects/session.jsonl"
ck_has "S18b2 the step summary is written for a real hit" "$(cat "$SUM")" "leak scan: 1"

echo
echo "== S18b: an exact match of the live credential is never downgraded =="
R="$(newroot s18b3)"
# The nightmare case: our token is ALSO in the PR's tree. Provenance says "the
# author's string"; that reading would silence the one hit that matters most.
printf 'const stolen = "%s";\n' "$FAKE_LIVE" >"$R/repo/src/fixture.js"
printf 'worker echoed %s\n' "$FAKE_LIVE" >"$R/home/.claude/projects/session.jsonl"
out="$(ANTHROPIC_AUTH_TOKEN="$FAKE_LIVE" RV2_ROOT="$R" "$SCAN" "$R" 2>&1)"
ck_has "S18b3 the live token is alarmed even though it is in the repo too" "$out" "ALARM"
ck_has "S18b3 and is named as an exact match" "$out" 'exact match of $ANTHROPIC_AUTH_TOKEN'

echo
echo "== S10: the payload that becomes the PR comment is scanned and redacted =="
R="$(newroot s10)"
cat >"$R/evidence/shard-a.json" <<EOF
{
  "version": "v2-evidence.1",
  "assignmentId": "shard-a",
  "mode": "test",
  "worker": "W1",
  "headOid": "$OID40",
  "commands": ["npm test"],
  "artifacts": [],
  "exitCodes": [0],
  "verdict": "fail",
  "notes": "",
  "binaryProvenance": null
}
EOF
# The exact shape the reviewer described: a worker records the probe command it
# ran, credential and all, as evidence. It is a legitimate finding; the evidence
# line is what must not reach the comment.
cat >"$R/output/review.json" <<EOF
{
  "version": "v2r1",
  "decision": "request_changes",
  "headOid": "$OID40",
  "findings": [
    {
      "taxonomy": "auth",
      "path": "src/server.js",
      "line": 42,
      "title": "the endpoint accepts an expired token",
      "evidence": {
        "mode": "test",
        "commands": ["curl -H \"Authorization: Bearer $FAKE_SHAPE_LEAK\" http://127.0.0.1:8080/v1"],
        "artifacts": [],
        "exitCodes": [0],
        "assignmentId": "shard-a"
      },
      "rootCause": "the middleware never checks exp",
      "level": "blocker",
      "fingerprint": "$(printf 'a%.0s' $(seq 1 64))"
    }
  ],
  "failures": [],
  "degradations": [],
  "resumedFrom": null
}
EOF
SUM="$WORK/summary-s10.md"; : >"$SUM"
wrap_out="$(cd "$R" && ANTHROPIC_AUTH_TOKEN="$FAKE_LIVE" RV2_ROOT="$R" HARNESS_DIR="$R" \
  HEAD_OID="$OID40" GITHUB_STEP_SUMMARY="$SUM" "$V2_DIR/wrapper.sh" 2>&1)"
rc=$?
ck "S10 the wrapper still succeeds" "0" "$rc"
ck_has "S10 the wrapper still reports a valid review" "$wrap_out" "review.json valid"
ck_has "S10 the redaction is announced" "$wrap_out" "PUBLISH GATE"

# The actual product: what the write job would post.
pub="$WORK/_publish-s10"
pub_out="$(REPOSITORY="Kizunad/Bong" PULL_NUMBER=1 BASE_OID="$OID40" HEAD_OID="$OID40" \
  RUN_ID=1 RUN_ATTEMPT=1 WORKFLOW_REF="$OID40" \
  POLICY_SHA256="$(printf 'b%.0s' $(seq 1 64))" \
  node "$V2_DIR/../harness/publish-artifact.mjs" "$R/output/review.json" "$pub" 2>&1)"
prc=$?
ck "S10 the publishable artifact still builds" "0" "$prc"
ck_lacks "S10 review.md - the PR comment body - carries no credential" \
  "$(cat "$pub/review.md" 2>/dev/null)" "$FAKE_SHAPE_LEAK"
ck_lacks "S10 the published review.json carries no credential either" \
  "$(cat "$pub/review.json" 2>/dev/null)" "$FAKE_SHAPE_LEAK"
ck_has "S10 the redaction is visible where the command was" \
  "$(cat "$pub/review.md" 2>/dev/null)" "[redacted-credential]"
# Redacting must not become "throw the review away": a sound verdict survives.
ck_has "S10 the verdict itself still publishes" "$(cat "$pub/review.md" 2>/dev/null)" "request_changes"
ck_has "S10 and the finding survives" "$(cat "$pub/review.md" 2>/dev/null)" "the endpoint accepts an expired token"
ck_has "S10 the run summary says what happened" "$(cat "$SUM")" "redacted"

echo
echo "== S10: a clean payload is left alone =="
R2="$(newroot s10clean)"
sed "s/curl -H .*v1/npm test/" "$R/output/review.json" >"$R2/output/review.json"
cp "$R/evidence/shard-a.json" "$R2/evidence/"
out="$(cd "$R2" && ANTHROPIC_AUTH_TOKEN="$FAKE_LIVE" RV2_ROOT="$R2" HARNESS_DIR="$R2" \
  HEAD_OID="$OID40" "$V2_DIR/wrapper.sh" 2>&1)"
ck_has "S10 a clean payload reports the gate as clean" "$out" "publish gate clean"
ck_lacks "S10 a clean payload is not rewritten" "$(cat "$R2/output/review.json")" "[redacted-credential]"

echo
echo "== S10: pane dumps must not put a token in the 90-day CI log =="
R="$(newroot dump)"
# A stub tmux, so this case needs no server and no panes. rv2_dump_panes shells
# out to `tmux list-windows` and `tmux capture-pane`; that is the whole contract.
mkdir -p "$WORK/stubbin"
cat >"$WORK/stubbin/tmux" <<'STUB'
#!/usr/bin/env bash
# Matched on the whole argument list: capture-pane is called as
# `tmux capture-pane -p -S -200 -t s:0`, so $1 is a flag, not the subcommand.
case "$*" in
  *list-windows*) echo 0 ;;
  *capture-pane*)
    echo "rv2: relay env file missing"
    echo "worker exported ANTHROPIC_AUTH_TOKEN=rv2-fake-not-a-real-credential-0001"
    echo "curl -H 'Authorization: Bearer sk-fakecrewleak000000000000' http://x/"
    ;;
esac
STUB
chmod +x "$WORK/stubbin/tmux"
dump_err="$WORK/dump.err"
(
  PATH="$WORK/stubbin:$PATH"
  export ANTHROPIC_AUTH_TOKEN="$FAKE_LIVE"
  export RV2_ROOT="$R"
  # shellcheck source=v2/lib.sh
  . "$V2_DIR/lib.sh"
  rv2_dump_panes boot-failed
) 2>"$dump_err"
err="$(cat "$dump_err")"
ck_lacks "S10 the stderr copy (CI log, 90 days) has no live token" "$err" "$FAKE_LIVE"
ck_lacks "S10 the stderr copy has no shaped token" "$err" "$FAKE_SHAPE_LEAK"
ck_has "S10 the stderr copy still carries the diagnosis" "$err" "relay env file missing"
ck_has "S10 the stderr copy shows that something was removed" "$err" "[redacted-credential]"
# The artifact copy keeps the raw text: 7 days, access-controlled, and swept by
# scan-leaks - forensics must survive somewhere or a rotation cannot be scoped.
ck_has "S10 the artifact copy keeps the evidence for forensics" \
  "$(cat "$R/logs/panes-boot-failed.log")" "$FAKE_LIVE"
scan_out="$(ANTHROPIC_AUTH_TOKEN="$FAKE_LIVE" RV2_ROOT="$R" "$SCAN" "$R" 2>&1)"
ck_has "S10 and the sweep alarms on that copy" "$scan_out" "panes-boot-failed.log"

echo
echo "== redactor unit: shapes in, marker out, prose untouched =="
red_in="$WORK/red-in.txt"
{
  printf 'plain prose stays\n'
  printf 'live=%s\n' "$FAKE_LIVE"
  printf 'shape=%s\n' "$FAKE_SHAPE_LEAK"
  printf 'gh=ghp_abcdefghijklmnopqrstuvwxyz01\n'
  printf 'aws=AKIAABCDEFGHIJKLMNOP\n'
  printf 'no trailing newline: ah-abcdefghijklmnopqrstuvwxyz'
} >"$red_in"
red_out="$( ANTHROPIC_AUTH_TOKEN="$FAKE_LIVE" bash -c '. "$1/lib.sh"; rv2_redact_stream' _ "$V2_DIR" <"$red_in")"
ck_has "redactor keeps prose" "$red_out" "plain prose stays"
ck_lacks "redactor removes the exact value" "$red_out" "$FAKE_LIVE"
ck_lacks "redactor removes an sk- shape" "$red_out" "$FAKE_SHAPE_LEAK"
ck_lacks "redactor removes a gh token shape" "$red_out" "ghp_abcdefghijklmnopqrstuvwxyz01"
ck_lacks "redactor removes an AWS key id shape" "$red_out" "AKIAABCDEFGHIJKLMNOP"
ck_has "redactor does not drop a final line with no newline" "$red_out" "no trailing newline"
ck_lacks "redactor redacts that final line too" "$red_out" "ah-abcdefghijklmnopqrstuvwxyz"

echo
echo "== S19: a failed jq rewrite must fail the script, not report success =="
H="$WORK/seed-broken"
mkdir -p "$H/.claude"
# Valid JSON, unexpected SHAPE - `has()` against an array is a jq error. This is
# the resumed-run case: a settings.json somebody or something else wrote.
printf '[]\n' >"$H/.claude/settings.json"
out="$(RV2_ROOT="$WORK/seed-broken-root" RV2_PANE_HOME="$H" "$SEED" 2>&1)"
rc=$?
ck "S19 a failed settings rewrite exits nonzero" "65" "$rc"
ck_has "S19 and says the rewrite failed, naming the file" "$out" "jq rewrite of $H/.claude/settings.json FAILED"
ck_has "S19 and points forward to the failure it prevents" "$out" "trunk never accepted"
ck_lacks "S19 and does NOT report success" "$out" "seed-claude-config: HOME="

H="$WORK/seed-broken-config"
mkdir -p "$H/.claude"
printf '{"projects": 5}\n' >"$H/.claude.json"
out="$(RV2_ROOT="$WORK/seed-broken-config-root" RV2_PANE_HOME="$H" "$SEED" 2>&1)"
rc=$?
ck "S19 a failed .claude.json rewrite exits nonzero" "65" "$rc"
ck_has "S19 and names .claude.json" "$out" "jq rewrite of $H/.claude.json FAILED"

echo
echo "== S19: the happy paths still work, and the keys really land =="
H="$WORK/seed-fresh"
ROOT_S="$WORK/seed-fresh-root"
out="$(RV2_ROOT="$ROOT_S" RV2_PANE_HOME="$H" "$SEED" 2>&1)"
ck "S19 a fresh HOME seeds cleanly" "0" "$?"
ck_has "S19 fresh HOME reports what it did" "$out" "seed-claude-config: HOME=$H"
ck "S19 the theme gate is cleared" "dark" "$(jq -r .theme "$H/.claude/settings.json")"
ck "S19 the trust gate is cleared for the state root" "true" \
  "$(jq -r --arg r "$ROOT_S" '.projects[$r].hasTrustDialogAccepted' "$H/.claude.json")"
ck "S19 the trust gate is cleared for the repo checkout" "true" \
  "$(jq -r --arg r "$ROOT_S/repo" '.projects[$r].hasTrustDialogAccepted' "$H/.claude.json")"

H="$WORK/seed-resumed"
mkdir -p "$H/.claude"
printf '{"theme": "light"}\n' >"$H/.claude/settings.json"
printf '{"projects": {"/somewhere/else": {"hasTrustDialogAccepted": true}}}\n' >"$H/.claude.json"
out="$(RV2_ROOT="$WORK/seed-resumed-root" RV2_PANE_HOME="$H" "$SEED" 2>&1)"
ck "S19 a resumed HOME seeds cleanly" "0" "$?"
ck "S19 a resumed HOME keeps the operator's theme" "light" "$(jq -r .theme "$H/.claude/settings.json")"
ck "S19 and gains the bypass-warning key" "true" \
  "$(jq -r .skipDangerousModePermissionPrompt "$H/.claude/settings.json")"
ck "S19 and keeps the projects it already had" "true" \
  "$(jq -r '.projects["/somewhere/else"].hasTrustDialogAccepted' "$H/.claude.json")"

echo
printf -- '--- %d ok / %d FAIL\n' "$ok" "$fail"
[ "$fail" -eq 0 ] || exit 1
exit 0
