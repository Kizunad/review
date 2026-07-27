import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runReview } from './orchestrator.mjs';
import { createClaudeRunner } from './claude-runner.mjs';
import { createSanitizedCallerSnapshot } from './caller-snapshot.mjs';

const SEVERITIES = new Set(['blocker', 'major', 'minor']);
const MAX_PUBLIC_FAILURES = 512;
const MAX_PUBLIC_FINDINGS = 128;
export const MAX_REVIEW_JSON_BYTES = 1_048_576;
export const MAX_REVIEW_MARKDOWN_BYTES = 65_536;
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

function nonEmptyBoundedText(value, maxLength, fallback) {
  const normalized = String(value ?? '').trim();
  const text = normalized.length > 0 ? normalized : fallback;
  let codePoints = 0;
  let end = 0;
  for (const symbol of text) {
    if (codePoints >= maxLength) break;
    codePoints += 1;
    end += symbol.length;
  }
  if (end === text.length) return text;
  let truncatedEnd = 0;
  let retained = 0;
  for (const symbol of text) {
    if (retained >= Math.max(0, maxLength - 1)) break;
    retained += 1;
    truncatedEnd += symbol.length;
  }
  return `${text.slice(0, truncatedEnd)}…`;
}

function publicFailure(failure) {
  return {
    stage: nonEmptyBoundedText(failure?.stage, 300, 'unknown-stage'),
    status: failureStatus(failure?.status),
    error: nonEmptyBoundedText(failure?.error, 4_000, 'runner returned no result'),
    ...(typeof failure?.diagnostic === 'string' && failure.diagnostic.trim().length > 0
      ? { diagnostic: nonEmptyBoundedText(failure.diagnostic, 4_000, 'diagnostic unavailable') }
      : {}),
  };
}

function reviewJsonBytes(review) {
  return Buffer.byteLength(`${JSON.stringify(review, null, 2)}\n`);
}

function failureStatus(value) {
  return value === 'schema_error' ? 'schema_error' : 'infra_error';
}

function failureReport(total, retained, counts) {
  const omitted = total - retained;
  const detail = ['infra_error', 'schema_error']
    .filter((status) => counts[status] > 0)
    .map((status) => `${status}=${counts[status]}`)
    .join(', ');
  return {
    stage: 'failure-report',
    status: 'infra_error',
    error: `Failure report truncated: ${omitted} of ${total} omitted (${detail}); decision remains infrastructure_failure`,
  };
}

function publicFailureCounts(failures) {
  const counts = { infra_error: 0, schema_error: 0 };
  for (const failure of failures) counts[failureStatus(failure?.status)] += 1;
  return counts;
}

export function compactReviewFailures(failures, {
  findings = [],
  maxBytes = MAX_REVIEW_JSON_BYTES,
} = {}) {
  if (!Array.isArray(failures)) throw new TypeError('failures must be an array');
  if (!Array.isArray(findings)) throw new TypeError('findings must be an array');
  const total = failures.length;
  const omittedCounts = publicFailureCounts(failures);
  const retained = [];
  const limit = Math.min(total, MAX_PUBLIC_FAILURES);
  for (let index = 0; index < limit; index += 1) {
    const candidate = publicFailure(failures[index]);
    const candidateStatus = failureStatus(failures[index]?.status);
    omittedCounts[candidateStatus] -= 1;
    const omitted = total - retained.length - 1;
    const compacted = omitted > 0
      ? [...retained, candidate, failureReport(total, retained.length + 1, omittedCounts)]
      : [...retained, candidate];
    if (compacted.length > MAX_PUBLIC_FAILURES || reviewJsonBytes({
      version: 'v1', decision: 'infrastructure_failure', findings, failures: compacted,
    }) > maxBytes) {
      omittedCounts[candidateStatus] += 1;
      break;
    }
    retained.push(candidate);
  }
  if (retained.length === total) return retained;
  const report = failureReport(total, retained.length, omittedCounts);
  const compacted = [...retained.slice(0, MAX_PUBLIC_FAILURES - 1), report];
  if (reviewJsonBytes({
    version: 'v1', decision: 'infrastructure_failure', findings, failures: compacted,
  }) <= maxBytes) return compacted;
  const allCounts = publicFailureCounts(failures);
  const fallback = [failureReport(total, 0, allCounts)];
  if (reviewJsonBytes({
    version: 'v1', decision: 'infrastructure_failure', findings: [], failures: fallback,
  }) <= maxBytes) return fallback;
  throw new Error('infrastructure failure report exceeds review.json publication budget');
}

export function compactFinalReview(review, maxBytes = MAX_REVIEW_JSON_BYTES) {
  if (!review || typeof review !== 'object' || Array.isArray(review)) throw new TypeError('review must be an object');
  if (!Array.isArray(review.findings) || !Array.isArray(review.failures)) {
    throw new TypeError('review findings and failures must be arrays');
  }
  if (review.decision === 'infrastructure_failure') {
    if (review.findings.length === 0
      && review.failures.length <= MAX_PUBLIC_FAILURES
      && reviewJsonBytes(review) <= maxBytes) return review;
    const failures = compactReviewFailures(review.failures, { findings: [], maxBytes });
    return { ...review, findings: [], failures };
  }
  if (review.findings.length <= MAX_PUBLIC_FINDINGS
    && review.failures.length === 0
    && reviewJsonBytes(review) <= maxBytes) return review;
  const fallback = {
    version: 'v1',
    decision: 'infrastructure_failure',
    findings: [],
    failures: [{
      stage: 'artifact-budget',
      status: 'infra_error',
      error: 'Validated review output exceeded the final review publication contract; no code verdict was published.',
    }],
  };
  if (reviewJsonBytes(fallback) > maxBytes) throw new Error('review.json publication fallback exceeds size limit');
  return fallback;
}

function markdownBytes(lines) {
  return Buffer.byteLength(`${lines.join('\n')}\n`);
}

function appendMarkdown(lines, entry, footer = []) {
  return markdownBytes([...lines, ...entry, ...footer]) <= MAX_REVIEW_MARKDOWN_BYTES;
}

function minimalInfrastructureMarkdown({ shadow } = {}) {
  const values = [
    shadow ? '## Central review (shadow)' : '## Central review',
    '',
    '**Decision:** `infrastructure_failure`',
    '',
    'The review could not complete safely within the publication budget. No approval or code finding was inferred.',
  ];
  const rendered = `${values.join('\n')}\n`;
  if (Buffer.byteLength(rendered) > MAX_REVIEW_MARKDOWN_BYTES) {
    throw new Error('minimal review.md exceeds publication size limit');
  }
  return rendered;
}

export function renderReviewMarkdown(review, metadata) {
  const {
    headOid, policyVersion, policySha256, shadow = false,
  } = metadata;
  const lines = [
    shadow ? '## Central review (shadow)' : '## Central review',
    '',
    `**Decision:** ${markdownCodeSpan(review.decision)}`,
    `**Reviewed head:** ${markdownCodeSpan(headOid)}`,
    `**Policy:** ${markdownCodeSpan(policyVersion)}`,
    `**Policy SHA-256:** ${markdownCodeSpan(policySha256)}`,
  ];
  if (markdownBytes(lines) > MAX_REVIEW_MARKDOWN_BYTES) {
    return minimalInfrastructureMarkdown(metadata);
  }
  if (review.decision === 'infrastructure_failure') {
    const introduction = [
      '',
      'The review could not complete safely. No approval or code finding was inferred from the failed stages.',
      '',
    ];
    if (!appendMarkdown(lines, introduction)) return minimalInfrastructureMarkdown(metadata);
    lines.push(...introduction);
    let omitted = 0;
    for (const [index, failure] of review.failures.entries()) {
      const entry = [
        `- ${markdownCodeSpan(failure.stage)} — ${markdownCodeSpan(failure.status)}: ${markdownCodeSpan(failure.error)}`,
        ...(failure.diagnostic ? [`  - diagnostic: ${markdownCodeSpan(failure.diagnostic)}`] : []),
      ];
      const remaining = review.failures.length - index - 1;
      const footer = remaining > 0
        ? ['', `${remaining} failure report(s) omitted to stay within the publication budget; decision remains infrastructure_failure.`]
        : [];
      if (!appendMarkdown(lines, entry, footer)) {
        omitted = review.failures.length - index;
        break;
      }
      lines.push(...entry);
    }
    if (omitted > 0) {
      const footer = ['', `${omitted} failure report(s) omitted to stay within the publication budget; decision remains infrastructure_failure.`];
      if (!appendMarkdown(lines, footer)) return minimalInfrastructureMarkdown(metadata);
      lines.push(...footer);
    }
    const rendered = `${lines.join('\n')}\n`;
    return Buffer.byteLength(rendered) <= MAX_REVIEW_MARKDOWN_BYTES
      ? rendered
      : minimalInfrastructureMarkdown(metadata);
  }
  if (review.findings.length === 0) {
    const empty = ['', 'No validated findings survived the five-vote gate.'];
    if (!appendMarkdown(lines, empty)) return minimalInfrastructureMarkdown(metadata);
    return `${[...lines, ...empty].join('\n')}\n`;
  }
  if (!appendMarkdown(lines, [''])) return minimalInfrastructureMarkdown(metadata);
  lines.push('');
  let omitted = 0;
  for (const [index, finding] of review.findings.entries()) {
    const entry = [
      `### [${finding.severity}] ${finding.title}`,
      '',
      `${markdownCodeSpan(`${finding.path}:${finding.line}`)} · ${markdownCodeSpan(finding.taxonomy)}`,
      '',
      finding.evidence,
      '',
      `**Root cause:** ${finding.rootCause}`,
      '',
    ];
    const remaining = review.findings.length - index - 1;
    const footer = remaining > 0
      ? [`${remaining} validated finding(s) omitted to stay within the publication budget.`, '']
      : [];
    if (!appendMarkdown(lines, entry, footer)) {
      omitted = review.findings.length - index;
      break;
    }
    lines.push(...entry);
  }
  if (omitted > 0) {
    const footer = [`${omitted} validated finding(s) omitted to stay within the publication budget.`];
    if (!appendMarkdown(lines, footer)) return minimalInfrastructureMarkdown(metadata);
    lines.push(...footer);
  }
  const rendered = `${lines.join('\n').trimEnd()}\n`;
  return Buffer.byteLength(rendered) <= MAX_REVIEW_MARKDOWN_BYTES
    ? rendered
    : minimalInfrastructureMarkdown(metadata);
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
  const rawFailures = Array.isArray(result.failures) ? result.failures : [];
  const publicFindings = result.findings.map(publicFinding);
  const decision = finalDecision({ ...result, failures: rawFailures }, trustedPolicy);
  const review = compactFinalReview({
    version: 'v1',
    decision,
    findings: decision === 'infrastructure_failure' ? [] : publicFindings,
    failures: decision === 'infrastructure_failure'
      ? compactReviewFailures(rawFailures, { findings: [] })
      : [],
  });
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
