#!/usr/bin/env bash
# 向工人 pane 送达一条指令的唯一入口 —— 精简移植自本地编排的 dispatch.sh(三写)。
#
# 保留的每一条防护都对应真实损失过工时的故障模式:
#   - 文本与 Enter 连发 -> 指令滞留输入框,下一轮巡检把工人误读为"无故空闲";
#   - 会话尚在启动/忙碌时送达 -> 指令被吞;
#   - 输入框里有陈稿 -> Enter 提交的是旧文本而不是新指令;
#   - 台账不更新 -> 巡检对着错误的 assignment 交叉核对状态。
#
# 三写:任务书/指令文件(先落盘,pane 崩了任务还在)+ tmux 送达验证 + 台账。
#
# 用法: dispatch.sh [--queue] <worker 1|2> <task-name> <directive text...>
# 环境: HARNESS_SESSION(tmux 会话)、HARNESS_DIR(状态根,布局见 layout.mjs)
#
# 本移植只面向 pi 风格的工人 pane:忙 = 可见画面里有 "Working..."。
# fake 桩通过 清屏+打印 模拟同一 TUI 契约,使真假两种模式共用同一忙检测。
set -uo pipefail

SESSION=${HARNESS_SESSION:?HARNESS_SESSION is required}
ROOT=${HARNESS_DIR:?HARNESS_DIR is required}
LEDGER="$ROOT/ledger.tsv"
DIRECTIVES="$ROOT/directives"

# --queue:向忙碌工人也送达,让 TUI 把指令排到当前回合结束。对"纠正在途工作"
# 是对的;对新任务是错的(打断无关工作等于浪费它)。
QUEUE=0
if [ "${1:-}" = "--queue" ]; then QUEUE=1; shift; fi

w=${1:?usage: dispatch.sh [--queue] <worker 1|2> <task-name> <directive...>}
task=${2:?usage: dispatch.sh [--queue] <worker 1|2> <task-name> <directive...>}
shift 2
text="$*"
[ -n "$text" ] || { echo "dispatch.sh: empty directive" >&2; exit 64; }

# 活跃工人 <= 2 的 524 铁律在结构上兑现:只有 w1/w2 两个工人窗口是合法目标,
# trunk 自己的窗口或任何别的编号一律拒绝。
case "$w" in
  1|2) window="w$w" ;;
  *) echo "dispatch.sh: worker must be 1 or 2 (active workers <= 2; never the trunk)" >&2; exit 64 ;;
esac

# ASCII-only —— 打进工人 pane 的内容的常设纪律。拒发优于默默毁写:
# send-keys -l 原样透传字节,TUI 会渲染 mojibake。
if LC_ALL=C grep -qP '[^\x09\x20-\x7E]' <<<"$text"; then
  echo "dispatch.sh: directive contains non-ASCII; worker briefs are ASCII-only" >&2
  exit 64
fi

pane() { tmux capture-pane -t "$SESSION:$window" -p 2>/dev/null; }
busy() { pane | grep -qF 'Working...'; }
alive() {
  # 会话开着 remain-on-exit:死 pane 仍挂在窗口上,必须看 pane_dead,
  # 不能拿"窗口还在"当活着(本地编排吃过"重启后遗像看似在线"的亏)。
  [ "$(tmux display-message -pt "$SESSION:$window" '#{pane_dead}' 2>/dev/null)" = "0" ]
}

alive || { echo "dispatch.sh: $window has no live worker process - relaunch it first" >&2; exit 69; }

if [ "$QUEUE" -eq 0 ]; then
  for _ in $(seq 1 20); do
    busy || break
    sleep 3
  done
  if busy; then
    echo "dispatch.sh: $window still busy after 60s - not interrupting it; re-run when it settles" >&2
    echo "dispatch.sh: if this is a correction to the work already in flight, use --queue" >&2
    exit 75
  fi
  # 清掉输入框里的任何残稿,否则我们的 Enter 会提交旧文本。
  tmux send-keys -t "$SESSION:$window" C-u
  sleep 0.5
fi

# 三写第 1 写:指令文件先落盘。pane 崩溃后的新会话凭它知道自己该干什么,
# 催办脚本凭它复述任务。
mkdir -p "$DIRECTIVES"
{
  printf '# W%s current brief\n\n' "$w"
  printf -- '- task: %s\n' "$task"
  printf -- '- dispatched: %s\n\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '%s\n' "$text"
} > "$DIRECTIVES/W$w.md"

send_once() {
  tmux send-keys -t "$SESSION:$window" -l "$text"
  sleep 0.7                      # 让 TUI 吃完整行再提交
  tmux send-keys -t "$SESSION:$window" Enter
  sleep 2
}

# 轮询而非单次采样:TUI 在 Enter 后可能要几秒才渲染出忙状态,单次采样会把
# 已接活正在思考的工人误判为"没接到"。evidence 已落盘视同接活成功
# (assignment 级幂等:活干完了当然算送达过)。
accepted() {
  local i
  for i in $(seq 1 10); do
    busy && return 0
    [ -f "$ROOT/evidence/$task.json" ] && return 0
    sleep 1
  done
  return 1
}

send_once
if ! accepted; then
  # 重试一次:常见原因是文本到达时会话正在渲染。先清残稿再发,避免同一指令排队两份。
  tmux send-keys -t "$SESSION:$window" C-u
  sleep 0.5
  send_once
fi

# 三写第 2 写:台账与派活同一口气更新,不留成"回头再记"。
mkdir -p "$ROOT"
touch "$LEDGER"
tmp=$(mktemp)
awk -F'\t' -v OFS='\t' -v k="W$w" -v t="$task" -v s="$(date -u +%Y-%m-%dT%H:%MZ)" \
  '$1==k{$2=t; $3=s; $4="dispatched"} {print}' "$LEDGER" > "$tmp" && mv "$tmp" "$LEDGER"
grep -q "^W$w"$'\t' "$LEDGER" || printf 'W%s\t%s\t%s\tdispatched\n' "$w" "$task" "$(date -u +%Y-%m-%dT%H:%MZ)" >> "$LEDGER"

# 三写第 3 写(送达验证)的结论:
if accepted; then
  echo "W$w <- $task (accepted)"
else
  echo "W$w <- $task (WARNING: pane did not go busy after two attempts - check it by hand)" >&2
  exit 1
fi
