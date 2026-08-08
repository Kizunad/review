import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ASSIGNMENT_ID, EVIDENCE_MODES, safeRelativePath, scanEvidence } from './evidence.mjs';
import { harnessLayout } from './layout.mjs';

// v2 runner 编排原型的 review.json 契约。
//
// 对外硬门槛与 v1 逐字兼容的部分:
//   - decision 枚举与判定不变式(infrastructure_failure ⇒ 零 finding 且至少一条
//     failure;approve ⇒ 零 failure 且 finding 全为 minor;request_changes ⇒
//     零 failure 且至少一条 finding);
//   - headOid 语义:审的必须是权威 PR head,不匹配即拒绝发布;
//   - finding 的 path/line/title/rootCause/level/fingerprint 字段边界。
// v2 新增:finding.evidence 从字符串升级为实测证据对象;顶层 degradations[] 与
// resumedFrom 字段(P1 只定义 schema,降级梯子本身是 P2)。
export const RUNNER_REVIEW_VERSION = 'v2r1';
export const REVIEW_DECISIONS = ['approve', 'request_changes', 'infrastructure_failure'];

const REVIEW_FIELDS = ['version', 'decision', 'headOid', 'findings', 'failures', 'degradations', 'resumedFrom'].sort();
const FINDING_FIELDS = ['taxonomy', 'path', 'line', 'title', 'evidence', 'rootCause', 'level', 'fingerprint'].sort();
const FINDING_EVIDENCE_FIELDS = ['mode', 'commands', 'artifacts', 'exitCodes', 'assignmentId'].sort();
const FAILURE_FIELDS = ['stage', 'status', 'error'].sort();
const FAILURE_FIELDS_DIAGNOSTIC = ['stage', 'status', 'error', 'diagnostic'].sort();
const DEGRADATION_FIELDS = ['at', 'from', 'to', 'reason'].sort();

const FINDING_LEVELS = ['blocker', 'major', 'minor'];
const FAILURE_STATUSES = ['infra_error', 'schema_error'];
const TAXONOMY = /^[a-z][a-z0-9-]{0,63}$/;
const FINGERPRINT = /^[a-f0-9]{64}$/;
const OID = /^[0-9a-f]{40}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

function exactFields(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === fields.length && actual.every((field, index) => field === fields[index]);
}

function boundedText(value, maxLength, minLength = 1) {
  return typeof value === 'string' && [...value].length >= minLength && [...value].length <= maxLength;
}

function validFindingEvidence(evidence) {
  return exactFields(evidence, FINDING_EVIDENCE_FIELDS)
    && EVIDENCE_MODES.includes(evidence.mode)
    && Array.isArray(evidence.commands) && evidence.commands.length >= 1 && evidence.commands.length <= 64
    && evidence.commands.every((command) => boundedText(command, 2000))
    && Array.isArray(evidence.artifacts) && evidence.artifacts.length <= 64
    && evidence.artifacts.every((artifact) => safeRelativePath(artifact))
    && Array.isArray(evidence.exitCodes) && evidence.exitCodes.length >= 1 && evidence.exitCodes.length <= 64
    && evidence.exitCodes.every((code) => Number.isInteger(code) && code >= 0 && code <= 255)
    && typeof evidence.assignmentId === 'string' && ASSIGNMENT_ID.test(evidence.assignmentId);
}

function validFinding(finding, completed, errors, index) {
  const label = `findings[${index}]`;
  if (!exactFields(finding, FINDING_FIELDS)) {
    errors.push(`${label} must have exactly the fields ${FINDING_FIELDS.join(', ')}`);
    return;
  }
  if (!TAXONOMY.test(String(finding.taxonomy))) errors.push(`${label}.taxonomy is malformed`);
  if (!safeRelativePath(finding.path)) errors.push(`${label}.path must be a bounded relative path`);
  if (!Number.isInteger(finding.line) || finding.line < 1) errors.push(`${label}.line must be a positive integer`);
  if (!boundedText(finding.title, 180)) errors.push(`${label}.title must be 1..180 characters`);
  if (!boundedText(finding.rootCause, 2000)) errors.push(`${label}.rootCause must be 1..2000 characters`);
  if (!FINDING_LEVELS.includes(finding.level)) errors.push(`${label}.level must be one of ${FINDING_LEVELS.join('|')}`);
  if (!FINGERPRINT.test(String(finding.fingerprint))) errors.push(`${label}.fingerprint must be 64 hex characters`);
  if (!validFindingEvidence(finding.evidence)) {
    errors.push(`${label}.evidence must be {mode, commands, artifacts, exitCodes, assignmentId}`);
  } else if (completed !== undefined && !completed.has(finding.evidence.assignmentId)) {
    // 证据出处硬校验:finding 只能引用已按契约落盘的 assignment 证据。
    // trunk 引用不存在的证据 = 判词与实测脱钩,按无效 review 处理。
    errors.push(`${label}.evidence.assignmentId ${finding.evidence.assignmentId} has no completed evidence on disk`);
  }
}

function validFailure(failure, errors, index) {
  const label = `failures[${index}]`;
  const hasDiagnostic = failure != null && typeof failure === 'object' && 'diagnostic' in failure;
  if (!exactFields(failure, hasDiagnostic ? FAILURE_FIELDS_DIAGNOSTIC : FAILURE_FIELDS)) {
    errors.push(`${label} must be {stage, status, error[, diagnostic]}`);
    return;
  }
  if (!boundedText(failure.stage, 300)) errors.push(`${label}.stage must be 1..300 characters`);
  if (!FAILURE_STATUSES.includes(failure.status)) errors.push(`${label}.status must be one of ${FAILURE_STATUSES.join('|')}`);
  if (!boundedText(failure.error, 4000)) errors.push(`${label}.error must be 1..4000 characters`);
  if (hasDiagnostic && !boundedText(failure.diagnostic, 4000)) errors.push(`${label}.diagnostic must be 1..4000 characters`);
}

function validDegradation(degradation, errors, index) {
  const label = `degradations[${index}]`;
  if (!exactFields(degradation, DEGRADATION_FIELDS)) {
    errors.push(`${label} must be {at, from, to, reason}`);
    return;
  }
  if (!boundedText(degradation.at, 64)) errors.push(`${label}.at must be 1..64 characters`);
  if (!boundedText(degradation.from, 64)) errors.push(`${label}.from must be 1..64 characters`);
  if (!boundedText(degradation.to, 64)) errors.push(`${label}.to must be 1..64 characters`);
  if (!boundedText(degradation.reason, 400)) errors.push(`${label}.reason must be 1..400 characters`);
}

// wrapper 的确定性终点:trunk 产物只有通过这里才算有效判词。
// completedAssignments 给定时做证据出处交叉校验(wrapper 总是给)。
export function validateRunnerReview(review, { headOid, completedAssignments } = {}) {
  const errors = [];
  if (!exactFields(review, REVIEW_FIELDS)) {
    return { ok: false, errors: [`review must have exactly the fields ${REVIEW_FIELDS.join(', ')}`] };
  }
  if (review.version !== RUNNER_REVIEW_VERSION) errors.push(`version must be ${RUNNER_REVIEW_VERSION}`);
  if (!REVIEW_DECISIONS.includes(review.decision)) errors.push(`decision must be one of ${REVIEW_DECISIONS.join('|')}`);
  if (typeof review.headOid !== 'string' || !OID.test(review.headOid)) errors.push('headOid must be a 40-hex object id');
  else if (headOid !== undefined && review.headOid !== headOid) {
    errors.push('review headOid does not match the authoritative PR head');
  }
  const completed = completedAssignments === undefined ? undefined : new Set(completedAssignments);
  if (!Array.isArray(review.findings) || review.findings.length > 128) {
    errors.push('findings must be an array of at most 128 entries');
  } else {
    review.findings.forEach((finding, index) => validFinding(finding, completed, errors, index));
  }
  if (!Array.isArray(review.failures) || review.failures.length > 512) {
    errors.push('failures must be an array of at most 512 entries');
  } else {
    review.failures.forEach((failure, index) => validFailure(failure, errors, index));
  }
  if (!Array.isArray(review.degradations) || review.degradations.length > 16) {
    errors.push('degradations must be an array of at most 16 entries');
  } else {
    review.degradations.forEach((degradation, index) => validDegradation(degradation, errors, index));
  }
  if (review.resumedFrom !== null && !(typeof review.resumedFrom === 'string' && RUN_ID.test(review.resumedFrom))) {
    errors.push('resumedFrom must be null or a bounded run id token');
  }
  if (Array.isArray(review.findings) && Array.isArray(review.failures)) {
    // 判定不变式与 v1 finalize 的 jq 校验逐字对应。
    if (review.decision === 'infrastructure_failure') {
      if (review.findings.length !== 0) errors.push('infrastructure_failure must carry zero findings');
      if (review.failures.length < 1) errors.push('infrastructure_failure must carry at least one failure');
    } else if (review.decision === 'approve') {
      if (review.failures.length !== 0) errors.push('approve must carry zero failures');
      if (!review.findings.every((finding) => finding?.level === 'minor')) {
        errors.push('approve findings must all be minor');
      }
    } else if (review.decision === 'request_changes') {
      if (review.failures.length !== 0) errors.push('request_changes must carry zero failures');
      if (review.findings.length < 1) errors.push('request_changes must carry at least one finding');
    }
  }
  return { ok: errors.length === 0, errors };
}

// trunk 死亡/超时/产物无效时 wrapper 兜底合成的 INFRA 判词。
// 合成结果必须能通过 validateRunnerReview —— 由测试守住。
export function synthesizeInfrastructureFailure({ headOid, stage = 'trunk', error, resumedFrom = null }) {
  const bounded = [...String(error ?? 'trunk produced no verifiable review')].slice(0, 4000).join('');
  const review = {
    version: RUNNER_REVIEW_VERSION,
    decision: 'infrastructure_failure',
    headOid: String(headOid ?? ''),
    findings: [],
    failures: [{ stage: String(stage), status: 'infra_error', error: bounded.length > 0 ? bounded : 'trunk produced no verifiable review' }],
    degradations: [],
    resumedFrom: typeof resumedFrom === 'string' && resumedFrom.length > 0 ? resumedFrom : null,
  };
  const { ok, errors } = validateRunnerReview(review, { headOid });
  if (!ok) throw new Error(`synthesized infrastructure failure is invalid: ${errors.join('; ')}`);
  return review;
}

// CLI:
//   node validate-review.mjs validate <review.json>
//     env HEAD_OID 必填;HARNESS_DIR 给定时扫 evidence 做出处交叉校验。
//     有效则打印 decision 到 stdout,无效打印错误到 stderr 并以 1 退出。
//   node validate-review.mjs synthesize <stage> <error...>
//     env HEAD_OID 必填、RESUMED_FROM 选填;打印合成的 INFRA review 到 stdout。
export async function runCli(argv, environment = process.env) {
  const headOid = String(environment.HEAD_OID ?? '');
  if (!OID.test(headOid)) throw new Error('HEAD_OID must be the authoritative 40-hex PR head');
  const [command, ...rest] = argv;
  if (command === 'validate') {
    const [file] = rest;
    if (!file) throw new Error('usage: validate-review.mjs validate <review.json>');
    let review;
    try {
      review = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      return { ok: false, errors: [`review.json unreadable: ${String(error.message ?? error)}`] };
    }
    let completedAssignments;
    if (environment.HARNESS_DIR) {
      const layout = harnessLayout(environment.HARNESS_DIR);
      const { completed } = await scanEvidence(layout.evidenceDir, { headOid });
      completedAssignments = completed.map((entry) => entry.assignmentId);
    }
    const { ok, errors } = validateRunnerReview(review, { headOid, completedAssignments });
    return { ok, errors, decision: ok ? review.decision : undefined };
  }
  if (command === 'synthesize') {
    const [stage, ...errorText] = rest;
    const review = synthesizeInfrastructureFailure({
      headOid,
      stage: stage || 'trunk',
      error: errorText.join(' '),
      resumedFrom: environment.RESUMED_FROM || null,
    });
    return { ok: true, review };
  }
  throw new Error('usage: validate-review.mjs validate|synthesize');
}

const invokedDirectly = typeof process.argv[1] === 'string'
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  const result = await runCli(process.argv.slice(2));
  if (result.review !== undefined) {
    process.stdout.write(`${JSON.stringify(result.review, null, 2)}\n`);
  } else if (result.ok) {
    process.stdout.write(`${result.decision}\n`);
  } else {
    for (const error of result.errors) process.stderr.write(`validate-review: ${error}\n`);
    process.exitCode = 1;
  }
}
