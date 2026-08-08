import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ASSIGNMENT_ID, scanEvidence } from './evidence.mjs';
import { harnessLayout } from './layout.mjs';

// checkpoint 最小切片(设计 §5.7):
//   粒度 = assignment 级幂等。完成判据只有一个 —— evidence 文件落盘且通过契约
//   校验;checkpoint 记录 {台账快照, 已完成分片清单},不做 transcript 级恢复。
//   resume 键 = PR + headOid + engine pin,三者任一不符即作废(测的必须是审的)。
export const CHECKPOINT_VERSION = 'v2-checkpoint.1';

const CHECKPOINT_FIELDS = ['version', 'key', 'runId', 'writtenAt', 'ledger', 'completedAssignments'].sort();
const KEY_FIELDS = ['pullNumber', 'headOid', 'enginePin'].sort();
const OID = /^[0-9a-f]{40}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const MAX_LEDGER_CHARS = 65536;

function exactFields(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === fields.length && actual.every((field, index) => field === fields[index]);
}

export function validCheckpointKey(key) {
  return exactFields(key, KEY_FIELDS)
    && Number.isInteger(key.pullNumber) && key.pullNumber >= 1
    && typeof key.headOid === 'string' && OID.test(key.headOid)
    && typeof key.enginePin === 'string' && OID.test(key.enginePin);
}

export function buildCheckpoint({ key, runId, ledger, completedAssignments }) {
  if (!validCheckpointKey(key)) throw new TypeError('checkpoint key must be {pullNumber, headOid, enginePin}');
  if (typeof runId !== 'string' || !RUN_ID.test(runId)) throw new TypeError('runId must be a bounded token');
  const ledgerText = String(ledger ?? '');
  if ([...ledgerText].length > MAX_LEDGER_CHARS) throw new RangeError('ledger snapshot exceeds the checkpoint bound');
  const ids = [...new Set(completedAssignments ?? [])];
  if (!ids.every((id) => typeof id === 'string' && ASSIGNMENT_ID.test(id))) {
    throw new TypeError('completedAssignments must be valid assignment ids');
  }
  return {
    version: CHECKPOINT_VERSION,
    key: { pullNumber: key.pullNumber, headOid: key.headOid, enginePin: key.enginePin },
    runId,
    writtenAt: new Date().toISOString(),
    ledger: ledgerText,
    completedAssignments: ids.sort(),
  };
}

// resume 接受判定:结构、版本、键三重校验;拒绝时给出确切原因。
export function acceptCheckpoint(data, expectedKey) {
  if (!validCheckpointKey(expectedKey)) throw new TypeError('expected key must be {pullNumber, headOid, enginePin}');
  if (!exactFields(data, CHECKPOINT_FIELDS)) return { ok: false, reason: 'checkpoint structure mismatch' };
  if (data.version !== CHECKPOINT_VERSION) return { ok: false, reason: `checkpoint version is not ${CHECKPOINT_VERSION}` };
  if (!validCheckpointKey(data.key)) return { ok: false, reason: 'checkpoint key structure mismatch' };
  for (const field of ['pullNumber', 'headOid', 'enginePin']) {
    if (data.key[field] !== expectedKey[field]) {
      return { ok: false, reason: `checkpoint ${field} does not match this run; resume state discarded` };
    }
  }
  if (typeof data.runId !== 'string' || !RUN_ID.test(data.runId)) return { ok: false, reason: 'checkpoint runId is malformed' };
  if (!Array.isArray(data.completedAssignments)
    || !data.completedAssignments.every((id) => typeof id === 'string' && ASSIGNMENT_ID.test(id))) {
    return { ok: false, reason: 'checkpoint completedAssignments are malformed' };
  }
  return {
    ok: true,
    completedAssignments: [...new Set(data.completedAssignments)].sort(),
    resumedFrom: data.runId,
  };
}

function environmentKey(environment) {
  const pullNumber = Number(environment.PR_NUMBER);
  return {
    pullNumber: Number.isInteger(pullNumber) ? pullNumber : NaN,
    headOid: String(environment.HEAD_OID ?? ''),
    enginePin: String(environment.ENGINE_PIN ?? ''),
  };
}

async function readOptional(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function atomicWrite(file, text) {
  const temporary = `${file}.tmp-${process.pid}`;
  await writeFile(temporary, text);
  await rename(temporary, file);
}

// CLI:
//   node checkpoint.mjs write   周期/退出打点:扫 evidence,写 checkpoint.json
//   node checkpoint.mjs resume  开工前判定 resume 状态,产出 completed.txt
// 两条子命令都从环境读 HARNESS_DIR / PR_NUMBER / HEAD_OID / ENGINE_PIN / RUN_ID。
export async function runCli(command, environment = process.env) {
  const layout = harnessLayout(environment.HARNESS_DIR ?? '.');
  const key = environmentKey(environment);
  if (!validCheckpointKey(key)) throw new Error('PR_NUMBER, HEAD_OID, and ENGINE_PIN must identify this run');
  if (command === 'write') {
    const runId = String(environment.RUN_ID ?? '');
    const { completed } = await scanEvidence(layout.evidenceDir, { headOid: key.headOid });
    const checkpoint = buildCheckpoint({
      key,
      runId,
      ledger: (await readOptional(layout.ledgerFile)) ?? '',
      completedAssignments: completed.map((entry) => entry.assignmentId),
    });
    await mkdir(layout.checkpointDir, { recursive: true });
    await atomicWrite(layout.checkpointFile, `${JSON.stringify(checkpoint, null, 2)}\n`);
    return { written: layout.checkpointFile, completed: checkpoint.completedAssignments };
  }
  if (command === 'resume') {
    await mkdir(layout.resumeDir, { recursive: true });
    const raw = await readOptional(layout.resumeCheckpointFile);
    let outcome = { ok: false, reason: 'no resume checkpoint present' };
    if (raw !== null) {
      try {
        outcome = acceptCheckpoint(JSON.parse(raw), key);
      } catch {
        outcome = { ok: false, reason: 'resume checkpoint is not valid JSON' };
      }
    }
    if (outcome.ok) {
      await atomicWrite(layout.resumeCompletedFile, outcome.completedAssignments.map((id) => `${id}\n`).join(''));
      await atomicWrite(layout.resumedFromFile, `${outcome.resumedFrom}\n`);
      return { resumed: true, completed: outcome.completedAssignments, resumedFrom: outcome.resumedFrom };
    }
    await atomicWrite(layout.resumeCompletedFile, '');
    await rm(layout.resumedFromFile, { force: true });
    return { resumed: false, reason: outcome.reason };
  }
  throw new Error('usage: checkpoint.mjs write|resume');
}

const invokedDirectly = typeof process.argv[1] === 'string'
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  const result = await runCli(process.argv[2]);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
