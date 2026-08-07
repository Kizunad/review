import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createSanitizedCallerSnapshot } from './caller-snapshot.mjs';
import { createClaudeRunner } from './claude-runner.mjs';
import { compareStrings } from './deterministic.mjs';
import { runReview } from './orchestrator.mjs';
import {
  MAX_PUBLIC_FAILURES,
  MAX_PUBLIC_FINDINGS,
  MAX_PUBLIC_SUGGESTIONS,
  PUBLIC_FAILURE_TEXT_LIMITS,
  PUBLIC_FINDING_TEXT_LIMITS,
} from './review-limits.mjs';

export {
  MAX_PUBLIC_FAILURES,
  MAX_PUBLIC_FINDINGS,
  MAX_PUBLIC_SUGGESTIONS,
  PUBLIC_FAILURE_TEXT_LIMITS,
  PUBLIC_FINDING_TEXT_LIMITS,
};

const LEVELS = new Set(['blocker', 'major', 'minor', 'suggestion']);
export const MAX_REVIEW_JSON_BYTES = 1_048_576;
export const MAX_REVIEW_MARKDOWN_BYTES = 65_536;
// Runaway guard, NOT a size policy. It was 1_048_576 from the first commit, and at that value it
// is a silent wall: PR #1315 was refused at 1,053,959 bytes - over by 0.5% - and got no review at
// all, for weeks, while the refusal was reported as `infrastructure_failure` and therefore read
// as "the engine is down" rather than "this PR is too big".
//
// What this actually bounds is the number of model calls, which scales linearly with diff size:
// at max_shard_chars=12000 and max_diff_chars=40000 over 8 taxonomy dimensions, a 1 MiB diff is
// ~88 summary calls plus 27 batches x 8 finders = ~304 calls. That is the one real cost, and it
// is the only thing bounding spend per review - unlike the stdout backstop next door, this cannot
// simply be deleted, because a PR that accidentally vendors a generated file would launch
// thousands of calls with nothing to stop it.
//
// So the default is placed where code and resources actually separate in this repository, rather
// than at a round number. Measured on Bong at d9b9db3d9:
//   largest genuine all-code PR diff   1,053,959 bytes  (#1315; then #1336 782KB, #1314 638KB)
//   smallest single resource blob      5,410,234 bytes  (a texture; generated blocks.json is
//                                                        6.2MB, an NBT preview page 8.9MB)
// There is a clean gap between those two populations. 4 MiB sits inside it: four times the
// largest all-code diff ever seen here, yet smaller than any ONE resource file - so a diff that
// exceeds it necessarily carries a generated or binary asset and cannot be all reviewable code.
// That makes the refusal mean something ("you vendored something") instead of being an arbitrary
// ceiling that a merely-large refactor can trip.
export const ABSOLUTE_DIFF_BYTES = 4 * 1024 * 1024;

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
    throw new Error('policy fields do not match the v2 contract');
  }
  if (value.version !== 'project-review-policy.v2') throw new Error('unsupported policy version');
  if (value.project !== repository) throw new Error('policy project does not match caller repository');
  if (typeof value.minorFindingsRequestChanges !== 'boolean') throw new Error('minorFindingsRequestChanges must be boolean');
  if (!Array.isArray(value.rules) || value.rules.length > 256) throw new Error('policy rules must be an array with at most 256 entries');
  for (const rule of value.rules) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw new Error('policy rule must be an object');
    if (Object.keys(rule).sort().join(',') !== 'id,level,text') throw new Error('policy rule fields do not match the v2 contract');
    if (typeof rule.id !== 'string' || !/^[a-z][a-z0-9-]{0,79}$/.test(rule.id)) throw new Error('policy rule ID is invalid');
    if (!LEVELS.has(rule.level)) throw new Error('policy rule level is invalid');
    if (typeof rule.text !== 'string' || [...rule.text].length < 1 || [...rule.text].length > 4_000) throw new Error('policy rule text is invalid');
  }
  return value;
}

export function finalDecision({ findings, failures }, policy) {
  if (failures.length > 0) return 'infrastructure_failure';
  if (findings.some((finding) => finding.level === 'blocker' || finding.level === 'major')) return 'request_changes';
  if (policy.minorFindingsRequestChanges && findings.some((finding) => finding.level === 'minor')) return 'request_changes';
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
    level: finding.level,
    fingerprint: finding.fingerprint,
  };
}

export function partitionValidatedFindings(findings) {
  if (!Array.isArray(findings)) throw new TypeError('findings must be an array');
  const defects = [];
  const advisory = [];
  for (const finding of findings) {
    const publicValue = publicFinding(finding);
    if (finding.level === 'suggestion') {
      advisory.push({ publicValue, voteSupport: Number.isInteger(finding.voteSupport) ? finding.voteSupport : 0 });
    } else {
      defects.push(publicValue);
    }
  }
  advisory.sort((left, right) => right.voteSupport - left.voteSupport
    || compareStrings(left.publicValue.fingerprint, right.publicValue.fingerprint));
  return {
    findings: defects,
    suggestions: advisory.slice(0, MAX_PUBLIC_SUGGESTIONS).map(({ publicValue }) => publicValue),
    omittedSuggestions: Math.max(0, advisory.length - MAX_PUBLIC_SUGGESTIONS),
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
    stage: nonEmptyBoundedText(failure?.stage, PUBLIC_FAILURE_TEXT_LIMITS.stage, 'unknown-stage'),
    status: failureStatus(failure?.status),
    error: nonEmptyBoundedText(failure?.error, PUBLIC_FAILURE_TEXT_LIMITS.error, 'runner returned no result'),
    ...(typeof failure?.diagnostic === 'string' && failure.diagnostic.trim().length > 0
      ? {
        diagnostic: nonEmptyBoundedText(
          failure.diagnostic,
          PUBLIC_FAILURE_TEXT_LIMITS.diagnostic,
          'diagnostic unavailable',
        ),
      }
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
  suggestions = [],
  omittedSuggestions = 0,
  maxBytes = MAX_REVIEW_JSON_BYTES,
} = {}) {
  if (!Array.isArray(failures)) throw new TypeError('failures must be an array');
  if (!Array.isArray(findings) || !Array.isArray(suggestions)) {
    throw new TypeError('findings and suggestions must be arrays');
  }
  if (!Number.isSafeInteger(omittedSuggestions) || omittedSuggestions < 0) {
    throw new TypeError('omittedSuggestions must be a non-negative safe integer');
  }
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
      version: 'v2',
      decision: 'infrastructure_failure',
      findings,
      suggestions,
      omittedSuggestions,
      failures: compacted,
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
    version: 'v2',
    decision: 'infrastructure_failure',
    findings,
    suggestions,
    omittedSuggestions,
    failures: compacted,
  }) <= maxBytes) return compacted;
  const allCounts = publicFailureCounts(failures);
  const fallback = [failureReport(total, 0, allCounts)];
  if (reviewJsonBytes({
    version: 'v2',
    decision: 'infrastructure_failure',
    findings: [],
    suggestions: [],
    omittedSuggestions: 0,
    failures: fallback,
  }) <= maxBytes) return fallback;
  throw new Error('infrastructure failure report exceeds review.json publication budget');
}

function artifactBudgetFallback() {
  return {
    version: 'v2',
    decision: 'infrastructure_failure',
    findings: [],
    suggestions: [],
    omittedSuggestions: 0,
    failures: [{
      stage: 'artifact-budget',
      status: 'infra_error',
      error: 'Validated review output exceeded the final review publication contract; no code verdict was published.',
    }],
  };
}

export function compactFinalReview(review, maxBytes = MAX_REVIEW_JSON_BYTES) {
  if (!review || typeof review !== 'object' || Array.isArray(review)) throw new TypeError('review must be an object');
  if (!Array.isArray(review.findings) || !Array.isArray(review.suggestions) || !Array.isArray(review.failures)) {
    throw new TypeError('review findings, suggestions, and failures must be arrays');
  }
  if (!Number.isSafeInteger(review.omittedSuggestions) || review.omittedSuggestions < 0) {
    throw new TypeError('review omittedSuggestions must be a non-negative safe integer');
  }
  if (review.decision === 'infrastructure_failure') {
    if (review.failures.length === 0) return artifactBudgetFallback();
    if (review.findings.length === 0
      && review.suggestions.length === 0
      && review.omittedSuggestions === 0
      && review.failures.length <= MAX_PUBLIC_FAILURES
      && reviewJsonBytes(review) <= maxBytes) return review;
    const failures = compactReviewFailures(review.failures, {
      findings: [], suggestions: [], omittedSuggestions: 0, maxBytes,
    });
    return {
      ...review,
      findings: [],
      suggestions: [],
      omittedSuggestions: 0,
      failures,
    };
  }
  const decisionContentsAreValid = review.failures.length === 0
    && (review.decision === 'approve'
      ? review.findings.every((finding) => finding?.level === 'minor')
      : review.decision === 'request_changes' && review.findings.length > 0);
  if (decisionContentsAreValid
    && review.findings.length <= MAX_PUBLIC_FINDINGS
    && review.suggestions.length <= MAX_PUBLIC_SUGGESTIONS
    && reviewJsonBytes(review) <= maxBytes) return review;
  const fallback = artifactBudgetFallback();
  if (reviewJsonBytes(fallback) > maxBytes) throw new Error('review.json publication fallback exceeds size limit');
  return fallback;
}

function markdownBytes(lines) {
  return Buffer.byteLength(`${lines.join('\n')}\n`);
}

function appendMarkdown(lines, entry, footer = []) {
  return markdownBytes([...lines, ...entry, ...footer]) <= MAX_REVIEW_MARKDOWN_BYTES;
}

function minimalReviewMarkdown(review, { shadow } = {}) {
  const values = [
    shadow ? '## Central review (shadow)' : '## Central review',
    '',
    `**Decision:** ${markdownCodeSpan(review.decision)}`,
    '',
    review.decision === 'infrastructure_failure'
      ? 'The review could not complete safely within the publication budget. No approval or code finding was inferred.'
      : 'The validated review result exceeded the Markdown publication budget. See the bound review.json artifact for the complete result.',
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
    return minimalReviewMarkdown(review, metadata);
  }
  if (review.decision === 'infrastructure_failure') {
    const introduction = [
      '',
      'The review could not complete safely. No approval or code finding was inferred from the failed stages.',
      '',
    ];
    if (!appendMarkdown(lines, introduction)) return minimalReviewMarkdown(review, metadata);
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
      if (!appendMarkdown(lines, footer)) return minimalReviewMarkdown(review, metadata);
      lines.push(...footer);
    }
    const rendered = `${lines.join('\n')}\n`;
    return Buffer.byteLength(rendered) <= MAX_REVIEW_MARKDOWN_BYTES
      ? rendered
      : minimalReviewMarkdown(review, metadata);
  }
  if (review.findings.length === 0 && review.suggestions.length === 0) {
    const empty = ['', 'No validated findings or suggestions survived the five-vote gate.'];
    if (!appendMarkdown(lines, empty)) return minimalReviewMarkdown(review, metadata);
    return `${[...lines, ...empty].join('\n')}\n`;
  }

  const appendFindingSection = (heading, entries, omittedLabel) => {
    if (entries.length === 0) return true;
    const section = ['', heading, ''];
    if (!appendMarkdown(lines, section)) return false;
    lines.push(...section);
    let omitted = 0;
    for (const [index, finding] of entries.entries()) {
      const entry = [
        `### [${finding.level}] ${finding.title}`,
        '',
        `${markdownCodeSpan(`${finding.path}:${finding.line}`)} · ${markdownCodeSpan(finding.taxonomy)}`,
        '',
        finding.evidence,
        '',
        `**Root cause:** ${finding.rootCause}`,
        '',
      ];
      const remaining = entries.length - index - 1;
      const footer = remaining > 0
        ? [`${remaining} ${omittedLabel} omitted from Markdown to stay within the publication budget.`, '']
        : [];
      if (!appendMarkdown(lines, entry, footer)) {
        omitted = entries.length - index;
        break;
      }
      lines.push(...entry);
    }
    if (omitted > 0) {
      const footer = [`${omitted} ${omittedLabel} omitted from Markdown to stay within the publication budget.`, ''];
      if (!appendMarkdown(lines, footer)) return false;
      lines.push(...footer);
    }
    return true;
  };

  if (!appendFindingSection('## Validated findings', review.findings, 'validated finding(s)')) {
    return minimalReviewMarkdown(review, metadata);
  }
  if (!appendFindingSection('## Suggestions (non-gating)', review.suggestions, 'published suggestion(s)')) {
    return minimalReviewMarkdown(review, metadata);
  }
  if (review.omittedSuggestions > 0) {
    const footer = [
      `${review.omittedSuggestions} additional suggestion(s) omitted from publication after semantic deduplication and ranking.`,
      '',
    ];
    if (!appendMarkdown(lines, footer)) return minimalReviewMarkdown(review, metadata);
    lines.push(...footer);
  }
  const rendered = `${lines.join('\n').trimEnd()}\n`;
  return Buffer.byteLength(rendered) <= MAX_REVIEW_MARKDOWN_BYTES
    ? rendered
    : minimalReviewMarkdown(review, metadata);
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
  // Optional. Undefined means "use the engine default" rather than "use zero", so a
  // caller that never sets it keeps runFreshClaude's backstop untouched.
  maxStdoutBytes,
  // Optional, same convention as maxStdoutBytes: undefined means "use ABSOLUTE_DIFF_BYTES".
  maxDiffBytes,
  shadow = false,
  stateDir,
  stateSalt = '',
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
    const diffByteCeiling = maxDiffBytes === undefined || maxDiffBytes === ''
      ? ABSOLUTE_DIFF_BYTES
      : positiveInteger(maxDiffBytes, 'maxDiffBytes', ABSOLUTE_DIFF_BYTES);
    if (diffBytes > diffByteCeiling) {
      // Named so the caller can tell a refusal from an outage. Both surface as
      // decision=infrastructure_failure, and reading one as the other cost several rounds of
      // treating a permanently-unreviewable PR as a transient engine problem to retry.
      throw new Error(
        `diff of ${diffBytes} bytes exceeds the ${diffByteCeiling} byte review ceiling `
        + '(this is a size refusal, not an engine failure; raise max_diff_bytes to review it)',
      );
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
      ...(maxStdoutBytes === undefined || maxStdoutBytes === ''
        ? {}
        : { maxStdoutBytes: positiveInteger(maxStdoutBytes, 'maxStdoutBytes', undefined) }),
      stateDir,
      stateSalt,
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
  const partitioned = partitionValidatedFindings(Array.isArray(result.findings) ? result.findings : []);
  const decision = finalDecision({ findings: partitioned.findings, failures: rawFailures }, trustedPolicy);
  const review = compactFinalReview({
    version: 'v2',
    decision,
    findings: decision === 'infrastructure_failure' ? [] : partitioned.findings,
    suggestions: decision === 'infrastructure_failure' ? [] : partitioned.suggestions,
    omittedSuggestions: decision === 'infrastructure_failure' ? 0 : partitioned.omittedSuggestions,
    failures: decision === 'infrastructure_failure'
      ? compactReviewFailures(rawFailures, {
        findings: [], suggestions: [], omittedSuggestions: 0,
      })
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
