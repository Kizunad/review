// fake-mode 桩终审:把已落盘的 evidence 组装成一份 v2r1 review.json。
// 不走捷径 —— 桩产物也必须通过 harness/validate-review.mjs 的真契约校验
// (headOid、证据 cross-check、判定不变式),否则冒烟就没有证明力。
//
// 判词规则(确定性):字典序第一份已完成 evidence 得到一条 minor finding
// (=> decision request_changes),其余 evidence 只作为完成状态存在。
// resume/resumed-from.txt 存在时如实记入 resumedFrom。
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { scanEvidence } from '../harness/evidence.mjs';
import { harnessLayout } from '../harness/layout.mjs';
import { validateRunnerReview } from '../harness/validate-review.mjs';

const headOid = String(process.env.HEAD_OID ?? '');
const layout = harnessLayout(process.env.HARNESS_DIR ?? process.env.RV2_ROOT ?? '.');

const { completed, invalid } = await scanEvidence(layout.evidenceDir, { headOid });
if (completed.length === 0) {
  throw new Error(`compose-review: no completed evidence (invalid: ${invalid.length})`);
}

let resumedFrom = null;
try {
  const raw = (await readFile(layout.resumedFromFile, 'utf8')).trim();
  if (raw.length > 0) resumedFrom = raw;
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const cited = completed[0];
const finding = {
  taxonomy: 'correctness',
  path: 'scripts/reviewed-file.sh',
  line: 1,
  title: `fake finding locked by assignment ${cited.assignmentId}`,
  evidence: {
    mode: cited.data.mode,
    commands: cited.data.commands,
    artifacts: cited.data.artifacts,
    exitCodes: cited.data.exitCodes,
    assignmentId: cited.assignmentId,
  },
  rootCause: 'deterministic fake verdict for the smoke chain',
  level: 'minor',
  fingerprint: createHash('sha256').update(cited.assignmentId).digest('hex'),
};

const review = {
  version: 'v2r1',
  decision: 'request_changes',
  headOid,
  findings: [finding],
  failures: [],
  degradations: [],
  resumedFrom,
};

const { ok, errors } = validateRunnerReview(review, {
  headOid,
  completedAssignments: completed.map((entry) => entry.assignmentId),
});
if (!ok) throw new Error(`compose-review: stub review failed the real contract: ${errors.join('; ')}`);

await mkdir(layout.outputDir, { recursive: true });
const temporary = `${layout.reviewFile}.tmp-${process.pid}`;
await writeFile(temporary, `${JSON.stringify(review, null, 2)}\n`);
await rename(temporary, layout.reviewFile);
process.stdout.write(`compose-review: ${path.basename(layout.reviewFile)} decision=${review.decision} resumedFrom=${resumedFrom ?? 'null'}\n`);
