import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runReview } from './orchestrator.mjs';
import { createClaudeRunner } from './claude-runner.mjs';
import { createSanitizedCallerSnapshot } from './caller-snapshot.mjs';

const SEVERITIES = new Set(['blocker', 'major', 'minor']);
export const ABSOLUTE_DIFF_BYTES = 262_144;

function markdownCodeSpan(value) {
  const text = String(value);
  const longestRun = (text.match(/`+/g) ?? []).reduce(
    (longest, run) => Math.max(longest, run.length),
    0,
  );
  const fence = '`'.repeat(longestRun + 1);
  return `${fence} ${text} ${fence}`;
}

function positiveInteger(value, name, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function parsePolicy(value, repository) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('policy must be an object');
  const keys = Object.keys(value).sort();
  const expected = ['minorFindingsRequestChanges', 'project', 'rules', 'version'].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error('policy fields do not match the v1 contract');
  }
  if (value.version !== 'project-review-policy.v1') throw new Error('unsupported policy version');
  if (value.project !== repository) throw new Error('policy project does not match caller repository');
  if (typeof value.minorFindingsRequestChanges !== 'boolean') throw new Error('minorFindingsRequestChanges must be boolean');
  if (!Array.isArray(value.rules) || value.rules.length > 256) throw new Error('policy rules must be an array with at most 256 entries');
  for (const rule of value.rules) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw new Error('policy rule must be an object');
    if (Object.keys(rule).sort().join(',') !== 'id,severity,text') throw new Error('policy rule fields do not match the v1 contract');
    if (typeof rule.id !== 'string' || !/^[a-z][a-z0-9-]{0,79}$/.test(rule.id)) throw new Error('policy rule ID is invalid');
    if (!SEVERITIES.has(rule.severity)) throw new Error('policy rule severity is invalid');
    if (typeof rule.text !== 'string' || rule.text.length < 1 || rule.text.length > 4000) throw new Error('policy rule text is invalid');
  }
  return value;
}

function finalDecision(result, policy) {
  if (result.failures.length > 0) return 'infrastructure_failure';
  if (result.findings.some((finding) => finding.severity === 'blocker' || finding.severity === 'major')) return 'request_changes';
  if (policy.minorFindingsRequestChanges && result.findings.some((finding) => finding.severity === 'minor')) return 'request_changes';
  return 'approve';
}

function publicFinding(finding) {
  return {
    taxonomy: finding.taxonomy,
    path: finding.path,
    line: finding.line,
    title: finding.title,
    evidence: finding.evidence,
    rootCause: finding.rootCause,
    severity: finding.severity,
    fingerprint: finding.fingerprint,
  };
}

export function renderReviewMarkdown(review, { headOid, policyVersion, policySha256, shadow = false }) {
  const lines = [
    shadow ? '## Central review (shadow)' : '## Central review',
    '',
    `**Decision:** \`${review.decision}\``,
    `**Reviewed head:** \`${headOid}\``,
    `**Policy:** \`${policyVersion}\``,
    `**Policy SHA-256:** \`${policySha256}\``,
  ];
  if (review.decision === 'infrastructure_failure') {
    lines.push('', 'The review could not complete safely. No approval or code finding was inferred from the failed stages.', '');
    for (const failure of review.failures) {
      lines.push(
        `- ${markdownCodeSpan(failure.stage)} — ${markdownCodeSpan(failure.status)}: ${markdownCodeSpan(failure.error)}`,
      );
      if (failure.diagnostic) lines.push(`  - diagnostic: ${markdownCodeSpan(failure.diagnostic)}`);
    }
    return `${lines.join('\n')}\n`;
  }
  if (review.findings.length === 0) {
    lines.push('', 'No validated findings survived the five-vote gate.');
    return `${lines.join('\n')}\n`;
  }
  lines.push('');
  for (const finding of review.findings) {
    lines.push(
      `### [${finding.severity}] ${finding.title}`,
      '',
      `\`${finding.path}:${finding.line}\` · \`${finding.taxonomy}\``,
      '',
      finding.evidence,
      '',
      `**Root cause:** ${finding.rootCause}`,
      '',
    );
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export async function executeReview({
  centralRoot,
  callerRoot,
  repository,
  diff,
  diffByteLength,
  policy,
  policySha256,
  environment,
  executable,
  ripgrepExecutable = process.env.RIPGREP_EXECUTABLE,
  sandboxExecutable = process.env.BWRAP_EXECUTABLE ?? 'bwrap',
  maxDiffChars = 40_000,
  maxShardChars = 12_000,
  workerTimeoutMs = 120_000,
  shadow = false,
}) {
  if (typeof diff !== 'string') throw new TypeError('diff must be a string');
  const finderLimit = positiveInteger(maxDiffChars, 'maxDiffChars', 40_000);
  const shardLimit = positiveInteger(maxShardChars, 'maxShardChars', 12_000);
  if (typeof policySha256 !== 'string' || !/^[0-9a-f]{64}$/.test(policySha256)) throw new Error('policySha256 must be a lowercase SHA-256');
  const trustedPolicy = parsePolicy(policy, repository);
  const catalog = JSON.parse(await readFile(path.join(centralRoot, 'catalog/review-dimensions.v1.json'), 'utf8'));
  let snapshot;
  let result;
  try {
    const measuredDiffBytes = Buffer.byteLength(diff);
    const diffBytes = diffByteLength === undefined ? measuredDiffBytes : Number(diffByteLength);
    if (!Number.isSafeInteger(diffBytes) || diffBytes < measuredDiffBytes) {
      throw new Error('diffByteLength must be a safe integer no smaller than the supplied diff bytes');
    }
    if (diffBytes > ABSOLUTE_DIFF_BYTES) {
      throw new Error(`diff exceeds absolute ${ABSOLUTE_DIFF_BYTES} byte safety limit`);
    }
    if (finderLimit < shardLimit) throw new Error('maxDiffChars must be at least maxShardChars');
    snapshot = await createSanitizedCallerSnapshot(callerRoot);
    const runner = createClaudeRunner({
      centralRoot,
      callerRoot: snapshot.root,
      policy: trustedPolicy,
      repository,
      environment: { ...environment, HOME: snapshot.home },
      executable,
      ripgrepExecutable,
      sandboxExecutable,
      timeoutMs: positiveInteger(workerTimeoutMs, 'workerTimeoutMs', 120_000),
    });
    result = await runReview({
      diff,
      taxonomy: catalog.dimensions,
      runner,
      maxShardChars: shardLimit,
      maxFinderChars: finderLimit,
    });
  } catch (error) {
    result = { findings: [], failures: [{ stage: 'orchestrator', status: 'infra_error', error: error.message }] };
  } finally {
    await snapshot?.cleanup();
  }
  const review = {
    version: 'v1',
    decision: finalDecision(result, trustedPolicy),
    findings: result.findings.map(publicFinding),
    failures: result.failures,
  };
  return {
    review,
    markdown: renderReviewMarkdown(review, {
      headOid: environment?.REVIEW_HEAD_OID ?? 'unknown',
      policyVersion: trustedPolicy.version,
      policySha256,
      shadow,
    }),
    policy: trustedPolicy,
  };
}
