import path from 'node:path';

// 单一状态根目录(HARNESS_DIR)下的固定布局。shell 侧(wrapper.sh / dispatch.sh /
// boot-session.sh / fake/*)硬编码同一组名字;改这里必须同步改它们。
//
//   ledger.tsv            工人台账(三写之一):worker \t task \t utc \t status
//   directives/           每工人当前任务书快照(W1.md / W2.md),崩溃后可恢复
//   assignments/          trunk 写的分片任务书(<id>.json),工人凭 id 领取
//   evidence/             证据契约文件 <id>.json + 附件目录 <id>/
//                         —— assignment 级幂等:evidence 落盘且校验通过即算完成
//   checkpoint/checkpoint.json  周期 + trap 退出时写入的断点
//   resume/checkpoint.json      上一次 run 恢复来的断点(wrapper 注入)
//   resume/completed.txt        resume 判定后已完成分片清单(trunk 只读它)
//   resume/resumed-from.txt     resume 生效时记录前次 run id
//   output/review.json          trunk 的终审产物(原子 mv 落盘)
//   logs/                 wrapper 与 pane 转录
export function harnessLayout(root) {
  const absolute = path.resolve(root);
  return {
    root: absolute,
    ledgerFile: path.join(absolute, 'ledger.tsv'),
    directivesDir: path.join(absolute, 'directives'),
    assignmentsDir: path.join(absolute, 'assignments'),
    evidenceDir: path.join(absolute, 'evidence'),
    checkpointDir: path.join(absolute, 'checkpoint'),
    checkpointFile: path.join(absolute, 'checkpoint', 'checkpoint.json'),
    resumeDir: path.join(absolute, 'resume'),
    resumeCheckpointFile: path.join(absolute, 'resume', 'checkpoint.json'),
    resumeCompletedFile: path.join(absolute, 'resume', 'completed.txt'),
    resumedFromFile: path.join(absolute, 'resume', 'resumed-from.txt'),
    outputDir: path.join(absolute, 'output'),
    reviewFile: path.join(absolute, 'output', 'review.json'),
    logsDir: path.join(absolute, 'logs'),
  };
}
