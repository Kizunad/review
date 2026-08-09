#!/usr/bin/env bash
# fake-mode 桩 trunk(不打任何 LLM):按 shard-diff.sh 产出的 assignments.json
# 顺序派活,复刻真实 trunk(claude -p + v2/trunk-prompt.md)的外部可观测行为:
#   resume 跳过 -> 逐片 dispatch(v2/dispatch.sh,三写+送达验证+活跃上限)->
#   收 evidence -> checkpoint -> 终审(fake/compose-review.mjs,经真契约校验)->
#   review.json 原子落盘。
#
# 冒烟脚本用的故障注入开关:
#   FAKE_TRUNK_STOP_AFTER=N  收齐第 N 份 evidence 后直接退出、不写 review.json
#                            (模拟 trunk 中途死亡 -> wrapper 兜底 INFRA)
#   FAKE_TRUNK_HANG=1        永久挂起(模拟 trunk 卡死 -> wait-review 超时收割)
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
V2="$REPO/v2"
# shellcheck source=v2/lib.sh
. "$V2/lib.sh"

ROOT="$(rv2_root)"
LOG="$ROOT/logs/fake-trunk.log"
mkdir -p "$ROOT/logs" "$ROOT/output" "$ROOT/evidence"
log() { printf 'fake-trunk: %s\n' "$*" | tee -a "$LOG"; }

if [ "${FAKE_TRUNK_HANG:-0}" = "1" ]; then
  log "hanging forever (watchdog leg)"
  sleep 100000
  exit 0
fi

ASSIGNMENTS="$ROOT/assignments/assignments.json"
[ -f "$ASSIGNMENTS" ] || { log "no assignments.json (run shard-diff.sh first)"; exit 70; }

completed_file="$ROOT/resume/completed.txt"
is_resumed_done() { [ -f "$completed_file" ] && grep -qx "$1" "$completed_file"; }
evidence_done() { [ -f "$ROOT/evidence/$1.json" ]; }

wait_evidence() { # id [timeout_s]
  local id="$1" timeout_s="${2:-90}" i
  for i in $(seq 1 "$timeout_s"); do
    evidence_done "$id" && return 0
    sleep 1
  done
  return 1
}

stop_after="${FAKE_TRUNK_STOP_AFTER:-0}"
next=1
dispatched=""
dispatched_count=0

for id in $(jq -r '.[] | select(.kind=="testable") | .id' "$ASSIGNMENTS"); do
  if is_resumed_done "$id"; then
    log "skip $id (resume)"
    continue
  fi
  if evidence_done "$id"; then
    log "skip $id (evidence already on disk)"
    continue
  fi
  path="$(jq -r --arg id "$id" '.[] | select(.id==$id) | .paths[0] // ""' "$ASSIGNMENTS")"
  # dispatch.sh 自身强制活跃 <= RV2_MAX_ACTIVE(满员 exit 75):被拒就等证据落盘再试。
  tries=0
  while :; do
    if "$V2/dispatch.sh" "W$next" "$id" TEST \
      "ASSIGNMENT $id path=$path repo=$ROOT/repo head=$(rv2_head_oid) evidence=$ROOT/evidence/$id.json per worker-brief" \
      >>"$LOG" 2>&1; then
      log "dispatched $id to W$next"
      break
    fi
    rc=$?
    tries=$((tries + 1))
    if [ "$tries" -ge 40 ]; then
      log "dispatch $id kept failing (last rc=$rc); giving up"
      exit 71
    fi
    log "dispatch $id refused (rc=$rc); waiting for a free worker"
    sleep 3
    next=$((3 - next))
  done
  next=$((3 - next))
  dispatched="$dispatched $id"
  dispatched_count=$((dispatched_count + 1))

  if [ "$stop_after" -gt 0 ] && [ "$dispatched_count" -ge "$stop_after" ]; then
    for d in $dispatched; do
      wait_evidence "$d" || { log "evidence for $d never landed"; exit 72; }
    done
    "$V2/checkpoint.sh" >>"$LOG" 2>&1 || true
    log "simulated trunk death after $stop_after assignments (no review.json)"
    exit 0
  fi
done

for id in $dispatched; do
  wait_evidence "$id" || { log "evidence for $id never landed"; exit 72; }
done

# 每个 assignment 有果即打点(trunk-prompt 的既定纪律),终审前再打一次。
"$V2/checkpoint.sh" >>"$LOG" 2>&1 || true

if ! node "$HERE/compose-review.mjs" >>"$LOG" 2>&1; then
  log "compose-review failed"
  exit 73
fi
log "review.json written"
