#!/usr/bin/env bash
# fake-mode 本地冒烟(交付物 7,关键证明):不打任何 LLM,用桩 trunk/worker 顶替
# claude/pi,在本机 tmux 里完整走通
#   pane 生命周期 -> dispatch(三写+送达验证+活跃上限) -> evidence 收集 ->
#   checkpoint -> wait-review 看门狗 -> wrapper 校验 -> review.json 产出 ->
#   INFRA 兜底 -> 断点续审跳过 -> resume 键作废
# 这条链绿了才算原型成立。
#
# 每条腿用独立的 tmux server(TMUX_TMPDIR 指到腿目录):pane 环境继承自该
# server 的启动进程,既不污染本机既有 tmux 会话,也不被其 tmux.conf 影响
# (boot-session.sh 另有 base-index 防御)。
#
# 用法: v2/smoke-fake.sh          (需要 tmux + jq + node)
#   env SMOKE_KEEP=1 保留工作目录供检查
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
command -v tmux >/dev/null || { echo "smoke: tmux required" >&2; exit 69; }
command -v jq >/dev/null || { echo "smoke: jq required" >&2; exit 69; }

# TMUX_TMPDIR only chooses the socket when we are NOT already inside tmux: an
# inherited $TMUX pins every client to the *outer* server, so running this smoke
# from a tmux pane would send boot-session.sh's `kill-session -t bong-v2` (and
# every dispatch send-keys) into the developer's real session. Unset at the door,
# once, so every leg below is isolated - including the ones that never boot a
# session but still probe pane liveness.
unset TMUX TMUX_PANE

HEAD_A="$(printf '1%.0s' $(seq 40))"
PIN_A="$(git -C "$REPO" rev-parse HEAD 2>/dev/null || printf '2%.0s' $(seq 40))"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/rv2-smoke.XXXXXX")"

FAILURES=0
pass() { echo "ok - $*"; }
fail() { echo "FAIL - $*"; FAILURES=$((FAILURES + 1)); }
assert_eq() { # label actual expected
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$3', got '$2')"; fi
}
assert_file_grep() { # label file pattern
  if [ -f "$2" ] && grep -qE "$3" "$2"; then pass "$1"; else fail "$1 (pattern '$3' not in $2)"; fi
}

write_fixture_diff() { # dir
  cat >"$1/diff.txt" <<'EOF'
diff --git a/scripts/a.sh b/scripts/a.sh
index 1111111..2222222 100755
--- a/scripts/a.sh
+++ b/scripts/a.sh
@@ -1 +1 @@
-echo old-a
+echo new-a
diff --git a/scripts/b.mjs b/scripts/b.mjs
index 3333333..4444444 100644
--- a/scripts/b.mjs
+++ b/scripts/b.mjs
@@ -1 +1 @@
-export const b = 1;
+export const b = 2;
diff --git a/scripts/c.py b/scripts/c.py
index 5555555..6666666 100644
--- a/scripts/c.py
+++ b/scripts/c.py
@@ -1 +1 @@
-print("old-c")
+print("new-c")
diff --git a/Cargo.lock b/Cargo.lock
index 7777777..8888888 100644
--- a/Cargo.lock
+++ b/Cargo.lock
@@ -1 +1 @@
-lock 1
+lock 2
EOF
}

# 一条 tmux 腿:准备目录 -> shard -> resume 判定 -> boot -> wait -> wrapper。
# 参数: 腿名 run_id review_timeout_s 附加env...(KEY=VALUE)
run_leg() {
  local leg="$1" run_id="$2" timeout_s="$3"
  shift 3
  local dir="$WORK/$leg"
  mkdir -p "$dir/logs" "$dir/resume" "$dir/evidence"
  write_fixture_diff "$dir"
  (
    export HARNESS_DIR="$dir" RV2_ROOT="$dir"
    export RV2_REPOSITORY='Kizunad/review' PR_NUMBER=1315
    export HEAD_OID="$HEAD_A" ENGINE_PIN="$PIN_A" RUN_ID="$run_id"
    export RV2_FAKE=1 FAKE_WORKER_DELAY_MS=6000
    export RV2_REVIEW_TIMEOUT_S="$timeout_s" RV2_REVIEW_POLL_S=2
    export RV2_CHECKPOINT_INTERVAL=5
    export TMUX_TMPDIR="$dir/tmux"
    mkdir -p "$TMUX_TMPDIR"
    local kv
    for kv in "$@"; do export "${kv?}"; done

    "$HERE/shard-diff.sh" "$dir/diff.txt" >>"$dir/logs/smoke.log" 2>&1 || { echo "shard failed" >&2; exit 1; }
    node "$REPO/harness/checkpoint.mjs" resume >>"$dir/logs/smoke.log" 2>&1 || true
    "$HERE/boot-session.sh" >>"$dir/logs/smoke.log" 2>&1 || { echo "boot failed" >&2; exit 1; }
    "$HERE/wait-review.sh" >>"$dir/logs/smoke.log" 2>&1 || true
    "$HERE/wrapper.sh" >>"$dir/logs/smoke.log" 2>&1 || true

    # 收尾:杀本腿的看门狗与专用 tmux server。
    #
    # 这里原本只发一次 SIGTERM 就当杀掉了。看门狗的 trap 收到 TERM 只写一次
    # checkpoint 然后**继续跑**,于是每跑一条腿就漏一个不死的看门狗——本机堆到 60 个,
    # 每个醒来都拉起一个吃 CPU 的 checkpoint 写入,把整机推过 New API 的 90% 主机
    # CPU 闸门,导致中央审查停摆一夜。trap 已修,但**清理动作不能依赖被清理方是对的**:
    # 确认它真的死了,没死就 SIGKILL。静默失败的清理正是 60 个能堆起来的原因。
    if [ -f "$dir/watchdog.pid" ]; then
      wd="$(cat "$dir/watchdog.pid")"
      kill "$wd" 2>/dev/null || true
      for _ in 1 2 3 4 5; do kill -0 "$wd" 2>/dev/null || break; sleep 0.4; done
      if kill -0 "$wd" 2>/dev/null; then
        echo "smoke: watchdog $wd ignored SIGTERM, SIGKILLing" >&2
        kill -9 "$wd" 2>/dev/null || true
      fi
    fi
    tmux kill-server 2>/dev/null || true
  )
}

echo "== leg A: full chain (3 testable shards + 1 skip) =="
run_leg run-a run-a 120
A="$WORK/run-a"
assert_eq "A review decision" "$(jq -r .decision "$A/output/review.json" 2>/dev/null)" "request_changes"
assert_eq "A findings count" "$(jq -r '.findings|length' "$A/output/review.json" 2>/dev/null)" "1"
assert_eq "A finding cites completed evidence" "$(jq -r '.findings[0].evidence.assignmentId' "$A/output/review.json" 2>/dev/null)" "s-0"
assert_eq "A resumedFrom is null" "$(jq -r '.resumedFrom' "$A/output/review.json" 2>/dev/null)" "null"
assert_eq "A checkpoint completed" "$(jq -c '.completedAssignments' "$A/checkpoint/checkpoint.json" 2>/dev/null)" '["s-0","s-1","s-2"]'
assert_eq "A checkpoint key pin" "$(jq -r '.key.enginePin' "$A/checkpoint/checkpoint.json" 2>/dev/null)" "$PIN_A"
assert_file_grep "A skip shard never dispatched" "$A/logs/fake-trunk.log" 'dispatched s-2'
if grep -qE 'dispatched s-3' "$A/logs/fake-trunk.log" 2>/dev/null; then fail "A skip shard s-3 was dispatched"; else pass "A s-3 (Cargo.lock) stayed undispatched"; fi
assert_file_grep "A ledger has dispatch rows" "$A/ledger.tsv" 's-0.*dispatched'
assert_file_grep "A dispatch delivery verified" "$A/logs/fake-trunk.log" 'dispatched s-0 to W1'

echo "== leg B: trunk dies after 2 assignments -> INFRA + checkpoint =="
run_leg run-b run-b 45 FAKE_TRUNK_STOP_AFTER=2
B="$WORK/run-b"
assert_eq "B review decision" "$(jq -r .decision "$B/output/review.json" 2>/dev/null)" "infrastructure_failure"
assert_eq "B failure stage" "$(jq -r '.failures[0].stage' "$B/output/review.json" 2>/dev/null)" "trunk"
assert_eq "B findings empty" "$(jq -r '.findings|length' "$B/output/review.json" 2>/dev/null)" "0"
assert_eq "B checkpoint completed" "$(jq -c '.completedAssignments' "$B/checkpoint/checkpoint.json" 2>/dev/null)" '["s-0","s-1"]'

echo "== leg C: resume from leg B checkpoint -> skip completed, finish the rest =="
C="$WORK/run-c"
mkdir -p "$C/resume" "$C/evidence"
cp "$B/checkpoint/checkpoint.json" "$C/resume/checkpoint.json"
cp "$B"/evidence/*.json "$C/evidence/"
run_leg run-c run-c 90
assert_file_grep "C resumed skip s-0" "$C/logs/fake-trunk.log" 'skip s-0 \(resume\)'
assert_file_grep "C resumed skip s-1" "$C/logs/fake-trunk.log" 'skip s-1 \(resume\)'
assert_eq "C only one dispatch" "$(grep -cE '^fake-trunk: dispatched ' "$C/logs/fake-trunk.log" 2>/dev/null)" "1"
assert_eq "C review decision" "$(jq -r .decision "$C/output/review.json" 2>/dev/null)" "request_changes"
assert_eq "C resumedFrom is the prior run" "$(jq -r '.resumedFrom' "$C/output/review.json" 2>/dev/null)" "run-b"
assert_eq "C checkpoint completed" "$(jq -c '.completedAssignments' "$C/checkpoint/checkpoint.json" 2>/dev/null)" '["s-0","s-1","s-2"]'

echo "== leg D: resume key mismatch (engine pin) -> checkpoint discarded =="
D="$WORK/run-d"
mkdir -p "$D/resume"
cp "$B/checkpoint/checkpoint.json" "$D/resume/checkpoint.json"
PIN_D="$(printf 'e%.0s' $(seq 40))"
resume_out="$(HARNESS_DIR="$D" PR_NUMBER=1315 HEAD_OID="$HEAD_A" ENGINE_PIN="$PIN_D" RUN_ID=run-d \
  node "$REPO/harness/checkpoint.mjs" resume 2>&1)"
case "$resume_out" in
  *'enginePin does not match'*) pass "D rejection reason names the pin" ;;
  *) fail "D rejection reason names the pin (got: $resume_out)" ;;
esac
assert_eq "D completed.txt emptied" "$(wc -c <"$D/resume/completed.txt" 2>/dev/null | tr -d ' ')" "0"
if [ -f "$D/resume/resumed-from.txt" ]; then fail "D resumed-from must not exist"; else pass "D resumed-from absent"; fi

echo "== leg E: trunk hangs -> wall-clock watchdog kills -> INFRA =="
run_leg run-e run-e 10 FAKE_TRUNK_HANG=1
E="$WORK/run-e"
assert_eq "E review decision" "$(jq -r .decision "$E/output/review.json" 2>/dev/null)" "infrastructure_failure"
assert_file_grep "E wait-review timed out" "$E/logs/smoke.log" 'wait-review: timeout'

echo "== leg F: active cap refuses the third dispatch (ENGINE524 pacing) =="
# Legs A-C never saturate the cap (the fake worker returns before a third shard
# is ready), so the limiter itself needs a direct leg: a ledger with two
# dispatched-but-incomplete rows is exactly the state the cap exists to refuse.
# The cap is checked before any pane liveness probe, so this leg needs no
# session - only an empty TMUX_TMPDIR so a stray tmux call cannot escape.
F="$WORK/run-f"
mkdir -p "$F/evidence" "$F/logs" "$F/tmux"
{
  printf 'worker\tassignment\tutc\tstatus\n'
  printf 'W1\ts-0\t2026-01-01T00:00Z\tdispatched\n'
  printf 'W2\ts-1\t2026-01-01T00:00Z\tdispatched\n'
} >"$F/ledger.tsv"
cap_out="$(RV2_ROOT="$F" HARNESS_DIR="$F" TMUX_TMPDIR="$F/tmux" \
  "$HERE/dispatch.sh" W1 s-2 TEST "ASSIGNMENT s-2 over the cap" 2>&1)"
cap_rc=$?
assert_eq "F cap refuses with rc=75" "$cap_rc" "75"
case "$cap_out" in
  *'at/over the cap of 2'*) pass "F refusal names the cap" ;;
  *) fail "F refusal names the cap (got: $cap_out)" ;;
esac
# Completing one shard frees a slot: the same call must get past the cap and
# fail later, on pane liveness, proving the gate counts evidence and not rows.
printf '{}\n' >"$F/evidence/s-0.json"
free_out="$(RV2_ROOT="$F" HARNESS_DIR="$F" TMUX_TMPDIR="$F/tmux" \
  "$HERE/dispatch.sh" W1 s-2 TEST "ASSIGNMENT s-2 under the cap" 2>&1)"
case "$free_out" in
  *'at/over the cap'*) fail "F completed evidence must free a slot (got: $free_out)" ;;
  *'no claude process'*) pass "F completed evidence frees a slot (stops at liveness)" ;;
  *) fail "F expected a liveness refusal after the slot freed (got: $free_out)" ;;
esac
# --queue is the deliberate bypass; it must never be refused by the cap.
printf 'W1\ts-2\t2026-01-01T00:00Z\tdispatched\n' >>"$F/ledger.tsv"
queue_out="$(RV2_ROOT="$F" HARNESS_DIR="$F" TMUX_TMPDIR="$F/tmux" \
  "$HERE/dispatch.sh" --queue W1 s-3 TEST "ASSIGNMENT s-3 queued past the cap" 2>&1)"
case "$queue_out" in
  *'at/over the cap'*) fail "F --queue must bypass the cap (got: $queue_out)" ;;
  *) pass "F --queue bypasses the cap" ;;
esac

echo "== leg G: empty relay env is a config refusal, not a pane death =="
# The first three CI trials all ended with "boot: trunk pane never came alive" after two and
# a half minutes of booting, and the real cause - relay variables sourced from secrets that
# exist in no repo - was invisible in that message. Boot must now refuse up front with
# EX_CONFIG and name the empty variable, and it must do so BEFORE creating a session (a leg
# that boots nothing is also the proof that it exits early).
#
# The pair used to be four names because pi needed its own AXONHUB_* set. It is two now, and
# unsetting the retired names would make this leg pass for the wrong reason - it would be
# testing variables nothing reads.
G="$WORK/run-g"
mkdir -p "$G/tmux"
g_out="$(env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN \
         RV2_ROOT="$G" HARNESS_DIR="$G" TMUX_TMPDIR="$G/tmux" RV2_FAKE=0 \
         "$HERE/boot-session.sh" 2>&1)"
g_rc=$?
assert_eq "G empty relay refuses with rc=78" "$g_rc" "78"
case "$g_out" in
  *ANTHROPIC_BASE_URL*ANTHROPIC_AUTH_TOKEN*) pass "G refusal names the empty variables" ;;
  *) fail "G refusal must name the empty variables (got: $g_out)" ;;
esac
# Asserted on the socket, not on the message: the refusal text deliberately quotes the old
# "pane never came alive" wording to explain what it replaces, so a string match here would
# pass on its own explanation. An empty TMUX_TMPDIR is the property that actually matters.
if [ -n "$(ls -A "$G/tmux" 2>/dev/null)" ]; then
  fail "G must refuse before starting a tmux server"
else
  pass "G refuses before booting a session"
fi

echo "== leg H: trunk dies mid-run -> early give-up WITH the panes captured =="
# Trial 4 (run 31302835151) is this leg's fixture. It booted cleanly for the first time, sat
# in wait-review for the full timeout, and produced decision=infrastructure_failure with
# "trunk produced no review.json" - and its artifact contained no logs, no evidence, no
# ledger, because wait-review killed the session without reading anything out of it. Two
# defects in one: the corpse was never examined, and the runner paid for the whole timeout
# after the review was already lost.
run_leg run-h run-h 60 FAKE_TRUNK_STOP_AFTER=1
H="$WORK/run-h"
assert_eq "H review decision" "$(jq -r .decision "$H/output/review.json" 2>/dev/null)" "infrastructure_failure"
assert_file_grep "H gave up early on a dead trunk" "$H/logs/smoke.log" 'trunk pane dead for'
if grep -q 'wait-review: timeout after' "$H/logs/smoke.log"; then
  fail "H must not sit out the full timeout once the trunk is gone"
else
  pass "H did not wait out the full timeout"
fi
if [ -s "$H/logs/panes-trunk-died.log" ]; then
  pass "H captured the panes before killing the session"
else
  fail "H must capture panes before kill-session - that output exists nowhere else"
fi

echo "== leg I: leak scan warns without blocking, and never prints the value =="
# Operator ruling 2026-08-10: the relay node is ours, so probe mode gets no key
# isolation - detection on the output side is enough and a hit must NOT block.
# The property that needs mechanizing is the one that is easy to get wrong in
# the obvious direction: a scanner that reports the secret has leaked it into a
# log with longer retention than the artifact it was guarding.
I="$WORK/run-i"
mkdir -p "$I/evidence" "$I/logs"
LIVE_TOKEN='tok-smoke-live-value-0123456789'
printf '{"notes":"clean enough","stray":"sk-abcdefghij0123456789XYZ"}\n' >"$I/evidence/s-0.json"
printf 'worker echoed %s by mistake\n' "$LIVE_TOKEN" >"$I/logs/pane.log"
# The two surfaces a hand-maintained target list had ALREADY missed while both
# were being uploaded as artifacts. Pinned here because the bug was not the
# missing entries, it was maintaining a second list at all - and a second list
# grows back.
mkdir -p "$I/checkpoint"
printf 'W1\ts-0\t2026-08-10T00:00Z\tsk-LEDGERaaaaaaaaaaaaaaaa1\n' >"$I/ledger.tsv"
printf '{"completed":["s-0"],"note":"sk-CHECKPOINTbbbbbbbbbbbb2"}\n' >"$I/checkpoint/checkpoint.json"
# ...and the reviewed repo, which must NOT be reported: a credential shape in
# there is the PR author's code, not a worker leaking ours. Scanning it would
# make every run with a fixture key cry wolf until nobody reads the alarm.
mkdir -p "$I/repo/src"
printf 'const k = "sk-INREPOccccccccccccccccc3";\n' >"$I/repo/src/x.js"
i_out="$(ANTHROPIC_AUTH_TOKEN="$LIVE_TOKEN" RV2_ROOT="$I" HARNESS_DIR="$I" \
         "$HERE/scan-leaks.sh" "$I" 2>&1)"
i_rc=$?
assert_eq "I leak scan never blocks (rc=0)" "$i_rc" "0"
case "$i_out" in
  *ALARM*) pass "I raises an alarm on a hit" ;;
  *) fail "I must raise an alarm (got: $i_out)" ;;
esac
case "$i_out" in
  *"exact match of \$ANTHROPIC_AUTH_TOKEN"*) pass "I catches the live token by exact match" ;;
  *) fail "I must catch the live token exactly, not only by shape" ;;
esac
case "$i_out" in
  *"credential-shaped"*) pass "I catches an unknown-value token by shape" ;;
  *) fail "I must catch sk- by shape" ;;
esac
case "$i_out" in
  *ledger.tsv*) pass "I scans ledger.tsv (uploaded, and the old list missed it)" ;;
  *) fail "I must scan ledger.tsv - it is uploaded as an artifact" ;;
esac
case "$i_out" in
  # The full path, not just "checkpoint": a bare glob would also match the word
  # in any future message the scanner prints, and pass without scanning anything.
  *checkpoint/checkpoint.json*) pass "I scans checkpoint/ (uploaded, and the old list missed it)" ;;
  *) fail "I must scan checkpoint/ - it is uploaded as an artifact" ;;
esac
case "$i_out" in
  *repo/src*) fail "I must NOT scan the reviewed repo - that is the author's code, not a leak" ;;
  *) pass "I leaves the reviewed repo alone" ;;
esac
# The one that matters. Asserted against BOTH the report file and the stdout/
# stderr the CI log captures - withholding it from one and not the other is the
# same leak.
if grep -q "$LIVE_TOKEN" "$I/logs/leak-scan.txt" 2>/dev/null; then
  fail "I report file must never contain the secret value"
else
  pass "I report file withholds the value"
fi
case "$i_out" in
  *"$LIVE_TOKEN"*) fail "I scanner output must never contain the secret value" ;;
  *) pass "I scanner output withholds the value" ;;
esac
# Rerunning must not find its own report - otherwise the count grows every run
# and the alarm becomes noise nobody reads.
i2="$(ANTHROPIC_AUTH_TOKEN="$LIVE_TOKEN" RV2_ROOT="$I" HARNESS_DIR="$I" \
      "$HERE/scan-leaks.sh" "$I" 2>&1 | grep -oE 'ALARM - [0-9]+' | grep -oE '[0-9]+')"
i1="$(grep -oE 'ALARM - [0-9]+' <<<"$i_out" | grep -oE '[0-9]+')"
assert_eq "I rerun does not scan its own report" "$i2" "$i1"
# And a clean tree must say so rather than staying silent - silence reads the
# same as "scanner never ran".
J="$WORK/run-j"; mkdir -p "$J/evidence" "$J/logs"
printf '{"notes":"nothing here"}\n' >"$J/evidence/s-0.json"
j_out="$(env -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_API_KEY RV2_ROOT="$J" \
         "$HERE/scan-leaks.sh" "$J" 2>&1)"
case "$j_out" in
  *clean*) pass "I clean tree reports clean, not silence" ;;
  *) fail "I clean tree must say so (got: $j_out)" ;;
esac

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "smoke-fake: ALL LEGS GREEN ($WORK)"
  [ "${SMOKE_KEEP:-0}" = "1" ] || rm -rf "$WORK"
  exit 0
fi
echo "smoke-fake: $FAILURES assertion(s) failed; state kept at $WORK" >&2
exit 1
