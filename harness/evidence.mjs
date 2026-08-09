import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

// 证据契约(v2 P1)。工人每完成一个 assignment 必须按此契约落一个
// evidence/<assignmentId>.json,附件放 evidence/<assignmentId>/ 下。
// assignment 级幂等的完成判据 = 该文件存在且通过本校验;checkpoint 与
// trunk 的 resume 跳过都只认这个判据,不认转录或台账。
export const EVIDENCE_VERSION = 'v2-evidence.1';
export const EVIDENCE_MODES = ['static', 'test', 'probe', 'adversarial'];

const EVIDENCE_FIELDS = [
  'version', 'assignmentId', 'mode', 'worker', 'headOid',
  'commands', 'artifacts', 'exitCodes', 'verdict', 'notes', 'binaryProvenance',
].sort();
const PROVENANCE_FIELDS = ['headOid', 'buildRunId'].sort();

export const ASSIGNMENT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const OID = /^[0-9a-f]{40}$/;
const WORKER = /^W[0-9]{1,2}$/;
const VERDICTS = ['pass', 'fail', 'blocked'];

function exactFields(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === fields.length && actual.every((field, index) => field === fields[index]);
}

function boundedText(value, maxLength, minLength = 1) {
  return typeof value === 'string' && [...value].length >= minLength && [...value].length <= maxLength;
}

export function safeRelativePath(value, maxLength = 500) {
  return boundedText(value, maxLength)
    && !value.includes('\u0000')
    && !value.startsWith('/')
    && !/(^|\/)\.\.(\/|$)/.test(value);
}

// 返回 { ok, errors }。headOid 给定时强制证据绑定被审 head(测的就是审的)。
export function validateEvidence(data, { headOid } = {}) {
  const errors = [];
  if (!exactFields(data, EVIDENCE_FIELDS)) {
    return { ok: false, errors: [`evidence must be an object with exactly the fields ${EVIDENCE_FIELDS.join(', ')}`] };
  }
  if (data.version !== EVIDENCE_VERSION) errors.push(`version must be ${EVIDENCE_VERSION}`);
  if (!ASSIGNMENT_ID.test(String(data.assignmentId))) errors.push('assignmentId must match ^[a-z0-9][a-z0-9-]{0,63}$');
  if (!EVIDENCE_MODES.includes(data.mode)) errors.push(`mode must be one of ${EVIDENCE_MODES.join('|')}`);
  if (!WORKER.test(String(data.worker))) errors.push('worker must match ^W[0-9]{1,2}$');
  if (typeof data.headOid !== 'string' || !OID.test(data.headOid)) errors.push('headOid must be a 40-hex object id');
  else if (headOid !== undefined && data.headOid !== headOid) errors.push('evidence headOid does not match the reviewed PR head');
  if (!Array.isArray(data.commands) || data.commands.length < 1 || data.commands.length > 64
    || !data.commands.every((command) => boundedText(command, 2000))) {
    errors.push('commands must be 1..64 bounded strings');
  }
  if (!Array.isArray(data.artifacts) || data.artifacts.length > 64
    || !data.artifacts.every((artifact) => safeRelativePath(artifact))) {
    errors.push('artifacts must be at most 64 safe relative paths');
  }
  if (!Array.isArray(data.exitCodes) || data.exitCodes.length < 1 || data.exitCodes.length > 64
    || !data.exitCodes.every((code) => Number.isInteger(code) && code >= 0 && code <= 255)) {
    errors.push('exitCodes must be 1..64 integers in 0..255');
  }
  if (!VERDICTS.includes(data.verdict)) errors.push(`verdict must be one of ${VERDICTS.join('|')}`);
  if (!boundedText(data.notes, 4000, 0)) errors.push('notes must be a string of at most 4000 characters');

  // artifact 出处铁律:被测二进制只能由本次 pipeline 的 build-server job 从被审
  // PR head 现场编译。P1 只有 test/static 模式、没有二进制,所以这里必须是 null;
  // probe 必须携带出处(headOid 必须等于证据自身的 headOid,附 build run id),
  // adversarial 视是否用二进制而定。手供二进制、外来二进制在 schema 上就不存在。
  if (data.mode === 'test' || data.mode === 'static') {
    if (data.binaryProvenance !== null) errors.push(`${data.mode} mode must not carry binaryProvenance (no binary under test)`);
  } else if (data.mode === 'probe' || data.mode === 'adversarial') {
    if (data.binaryProvenance === null) {
      if (data.mode === 'probe') errors.push('probe mode requires binaryProvenance from the pipeline build job');
    } else if (!exactFields(data.binaryProvenance, PROVENANCE_FIELDS)
      || !OID.test(String(data.binaryProvenance.headOid))
      || !boundedText(data.binaryProvenance.buildRunId, 100)) {
      errors.push('binaryProvenance must be {headOid, buildRunId} with a 40-hex headOid');
    } else if (typeof data.headOid === 'string' && data.binaryProvenance.headOid !== data.headOid) {
      errors.push('binaryProvenance.headOid must equal the evidence headOid (the binary must be built from the reviewed head)');
    }
  }
  return { ok: errors.length === 0, errors };
}

// 扫描 evidence 目录,返回已完成分片与无效文件。文件名必须等于
// <assignmentId>.json,防止一份证据冒领另一个分片的完成状态。
export async function scanEvidence(evidenceDir, { headOid } = {}) {
  const completed = [];
  const invalid = [];
  let entries;
  try {
    entries = await readdir(evidenceDir);
  } catch (error) {
    if (error.code === 'ENOENT') return { completed, invalid };
    throw error;
  }
  for (const entry of entries.filter((name) => name.endsWith('.json')).sort()) {
    const file = path.join(evidenceDir, entry);
    try {
      const info = await stat(file);
      if (!info.isFile()) {
        invalid.push({ file: entry, errors: ['evidence entry is not a regular file'] });
        continue;
      }
      const data = JSON.parse(await readFile(file, 'utf8'));
      const { ok, errors } = validateEvidence(data, { headOid });
      if (!ok) {
        invalid.push({ file: entry, errors });
        continue;
      }
      if (`${data.assignmentId}.json` !== entry) {
        invalid.push({ file: entry, errors: ['evidence file name must be <assignmentId>.json'] });
        continue;
      }
      completed.push({ assignmentId: data.assignmentId, file: entry, data });
    } catch (error) {
      invalid.push({ file: entry, errors: [String(error.message ?? error)] });
    }
  }
  return { completed, invalid };
}
