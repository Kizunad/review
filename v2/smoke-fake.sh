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
    [ -f "$dir/watchdog.pid" ] && kill "$(cat "$dir/watchdog.pid")" 2>/dev/null || true
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

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "smoke-fake: ALL LEGS GREEN ($WORK)"
  [ "${SMOKE_KEEP:-0}" = "1" ] || rm -rf "$WORK"
  exit 0
fi
echo "smoke-fake: $FAILURES assertion(s) failed; state kept at $WORK" >&2
exit 1
