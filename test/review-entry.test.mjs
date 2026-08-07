import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifyManifest } from '../src/artifact-manifest.mjs';
import {
  ABSOLUTE_DIFF_BYTES,
  MAX_PUBLIC_SUGGESTIONS,
  MAX_REVIEW_JSON_BYTES,
  MAX_REVIEW_MARKDOWN_BYTES,
  compactFinalReview,
  compactReviewFailures,
  executeReview,
  finalDecision,
  partitionValidatedFindings,
  renderReviewMarkdown,
} from '../src/review-entry.mjs';

const policy = {
  version: 'project-review-policy.v2',
  project: 'org/repo',
  rules: [{ id: 'canonical-contract', level: 'major', text: 'Keep the canonical contract connected end to end.' }],
  minorFindingsRequestChanges: true,
};

const policySha256 = createHash('sha256').update(JSON.stringify(policy)).digest('hex');

async function runNode(args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stderr }));
  });
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'review-entry-'));
  const callerRoot = path.join(root, 'caller');
  await mkdir(callerRoot);
  await mkdir(path.join(callerRoot, '.claude'));
  await writeFile(path.join(callerRoot, '.claude', 'settings.json'), '{"hooks":{"SessionStart":[]}}');
  await writeFile(path.join(callerRoot, '.mcp.json'), '{"mcpServers":{"attacker":{"command":"false"}}}');
  await writeFile(path.join(callerRoot, 'CLAUDE.md'), 'untrusted instructions');
  await mkdir(path.join(callerRoot, 'src'));
  await writeFile(path.join(callerRoot, 'src', 'a.mjs'), 'export const changed = true;\n');
  const executable = path.join(root, 'fake-claude.sh');
  await writeFile(executable, `#!/bin/sh
set -eu
[ "$PWD" = /workspace ]
[ "$HOME" = /home/claude ]
[ -f src/a.mjs ]
[ ! -e .claude ]
[ ! -e .mcp.json ]
[ ! -e CLAUDE.md ]
[ ! -e ${JSON.stringify(path.join(callerRoot, 'CLAUDE.md'))} ]
prompt="$(cat)"
model=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = '--model' ]; then model="$2"; break; fi
  shift
done
# Branch on the STAGE, never on the model. Models are routing placeholders the
# relay resolves - any well-formed name is legal here, so the model arm is only
# a plumbing guard: empty or flag-shaped means the --model arg went missing.
case "$model" in
  ''|-*) exit 9 ;;
  *)
    case "$prompt" in
      *planner*) output='{"version":"v1","assignments":[{"id":"all","shardIndexes":[0]}]}' ;;
      *summarizer*) output='{"version":"v1","summary":"one changed file","files":["src/a.mjs"]}' ;;
      *) output='[]' ;;
    esac ;;
esac
printf '{"type":"result","structured_output":%s}\n' "$output"
`);
  await chmod(executable, 0o755);
  return { callerRoot, executable };
}

async function fixtureWithFinding(level) {
  const value = await fixture();
  const candidate = {
    version: 'v2',
    taxonomy: 'security',
    path: 'src/a.mjs',
    line: 1,
    title: 'Validated candidate',
    evidence: 'The changed route reaches the observable result.',
    rootCause: 'the changed contract is not enforced',
    level: 'major',
  };
  await writeFile(value.executable, `#!/usr/bin/env node
const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
const prompt = Buffer.concat(chunks).toString('utf8');
let output;
if (prompt.includes('fresh Sol planner')) {
  output = { version: 'v1', assignments: [{ id: 'all', shardIndexes: [0] }] };
} else if (prompt.includes('fresh Luna summarizer')) {
  output = { version: 'v1', summary: 'one changed file', files: ['src/a.mjs'] };
} else if (prompt.includes('fresh Terra finder')) {
  output = prompt.includes('"id": "security"') ? [${JSON.stringify(candidate)}] : [];
} else if (prompt.includes('fresh Sol consolidator')) {
  const fingerprint = prompt.match(/"fingerprint": "([a-f0-9]{64})"/)?.[1];
  output = {
    version: 'v2',
    clusters: [{ representativeFingerprint: fingerprint, memberFingerprints: [fingerprint] }],
  };
} else if (prompt.includes('fresh Terra validator')) {
  const candidateFingerprint = prompt.match(/"fingerprint": "([a-f0-9]{64})"/)?.[1];
  output = {
    version: 'v2',
    candidateFingerprint,
    verdict: 'confirm',
    reachable: true,
    level: ${JSON.stringify(level)},
    evidence: 'The production path is reachable.',
    reason: 'The candidate survives independent refutation.',
  };
} else {
  process.exitCode = 9;
  return;
}
process.stdout.write(JSON.stringify({ type: 'result', structured_output: output }) + '\\n');
});
`);
  await chmod(value.executable, 0o755);
  return value;
}

async function executeFinding(level, policyOverride = {}) {
  const { callerRoot, executable } = await fixtureWithFinding(level);
  return executeReview({
    centralRoot: path.resolve('.'),
    callerRoot,
    repository: 'org/repo',
    diff: 'diff --git a/src/a.mjs b/src/a.mjs\n+changed\n',
    policy: { ...policy, ...policyOverride },
    policySha256,
    executable,
    ripgrepExecutable: executable,
    environment: { PATH: process.env.PATH, REVIEW_HEAD_OID: 'a'.repeat(40) },
  });
}

test('executes every review stage inside the isolated sanitized snapshot', async () => {
  const { callerRoot, executable } = await fixture();
  const result = await executeReview({
    centralRoot: path.resolve('.'),
    callerRoot,
    repository: 'org/repo',
    diff: 'diff --git a/src/a.mjs b/src/a.mjs\n+changed\n',
    policy,
    policySha256,
    executable,
    ripgrepExecutable: executable,
    environment: { PATH: process.env.PATH, REVIEW_HEAD_OID: 'a'.repeat(40) },
  });
  assert.equal(result.review.decision, 'approve');
  assert.deepEqual(result.review.findings, []);
  assert.deepEqual(result.review.suggestions, []);
  assert.equal(result.review.omittedSuggestions, 0);
  assert.deepEqual(result.review.failures, []);
});

test('suggestions remain non-gating while blocker, major, and configured minor defects gate', () => {
  const result = (level, failures = []) => ({ findings: [{ level }], failures });
  assert.equal(finalDecision(result('blocker'), policy), 'request_changes');
  assert.equal(finalDecision(result('major'), policy), 'request_changes');
  assert.equal(finalDecision(result('minor'), policy), 'request_changes');
  assert.equal(finalDecision(result('minor'), { ...policy, minorFindingsRequestChanges: false }), 'approve');
  assert.equal(finalDecision(result('suggestion'), policy), 'approve');
  assert.equal(finalDecision(result('suggestion'), { ...policy, minorFindingsRequestChanges: false }), 'approve');
  assert.equal(finalDecision(result('suggestion', [{ status: 'infra_error' }]), policy), 'infrastructure_failure');
});

test('publishes at most sixteen ranked suggestions and reports the omitted count', () => {
  const suggestions = Array.from({ length: 20 }, (_, index) => ({
    taxonomy: 'strict-maintainability',
    path: 'src/a.mjs',
    line: index + 1,
    title: `Suggestion ${index}`,
    evidence: `Improvement ${index}`,
    rootCause: `advisory-${index}`,
    level: 'suggestion',
    fingerprint: index.toString(16).padStart(64, '0'),
    voteSupport: index % 5,
  }));
  const partitioned = partitionValidatedFindings([
    {
      ...suggestions[0],
      taxonomy: 'correctness',
      level: 'minor',
      fingerprint: 'f'.repeat(64),
    },
    ...suggestions,
  ]);
  assert.equal(partitioned.findings.length, 1);
  assert.equal(partitioned.findings[0].level, 'minor');
  assert.equal(partitioned.suggestions.length, MAX_PUBLIC_SUGGESTIONS);
  assert.equal(partitioned.omittedSuggestions, 4);
  const expectedIndexes = [
    4, 9, 14, 19,
    3, 8, 13, 18,
    2, 7, 12, 17,
    1, 6, 11, 16,
  ];
  const expectedFingerprints = expectedIndexes.map(
    (index) => index.toString(16).padStart(64, '0'),
  );
  assert.deepEqual(
    partitioned.suggestions.map((entry) => entry.fingerprint),
    expectedFingerprints,
  );
  assert.ok(partitioned.suggestions.every((entry) => !('voteSupport' in entry)));
});

test('executeReview separates a five-vote suggestion from defects and keeps approval', async () => {
  const result = await executeFinding('suggestion');
  assert.equal(result.review.version, 'v2');
  assert.equal(result.review.decision, 'approve');
  assert.deepEqual(result.review.findings, []);
  assert.equal(result.review.suggestions.length, 1);
  assert.equal(result.review.suggestions[0].level, 'suggestion');
  assert.equal(result.review.omittedSuggestions, 0);
  assert.deepEqual(result.review.failures, []);
  assert.match(result.markdown, /Suggestions \(non-gating\)/);
  assert.doesNotMatch(result.markdown, /Validated findings\n\n###/);
});

test('shards diffs above the finder budget and bounds absolute input before spawning Claude', async () => {
  const { callerRoot, executable } = await fixture();
  const aboveFinderBudget = await executeReview({
    centralRoot: path.resolve('.'),
    callerRoot,
    repository: 'org/repo',
    diff: 'x'.repeat(40_001),
    policy,
    policySha256,
    executable,
    ripgrepExecutable: executable,
    maxDiffChars: 40_000,
    maxShardChars: 12_000,
    environment: { PATH: process.env.PATH },
  });
  assert.equal(aboveFinderBudget.review.decision, 'approve');
  assert.deepEqual(aboveFinderBudget.review.failures, []);

  const oversized = await executeReview({
    centralRoot: path.resolve('.'),
    callerRoot,
    repository: 'org/repo',
    diff: '',
    diffByteLength: ABSOLUTE_DIFF_BYTES + 1,
    policy,
    policySha256,
    executable: '/must-not-spawn',
    maxDiffChars: 40_000,
    maxShardChars: 12_000,
    environment: { PATH: process.env.PATH },
  });
  assert.equal(oversized.review.decision, 'infrastructure_failure');
  assert.deepEqual(oversized.review.findings, []);
  assert.match(oversized.review.failures[0].error, new RegExp(`exceeds the ${ABSOLUTE_DIFF_BYTES} byte review ceiling`));
});
test('rejects multibyte diffs above the byte limit before spawning Claude', async () => {
  const { callerRoot } = await fixture();
  // Derived from the constant, not a number copied out of it. This was `'界'.repeat(349_526)`,
  // sized by hand for a 1 MiB ceiling, so raising the ceiling silently turned the test's own
  // premise false - it stopped exercising the multibyte path it exists to cover. The point is
  // that a string SHORTER than the limit in characters can still exceed it in UTF-8 bytes, and
  // that holds at any ceiling as long as the count is computed from it.
  const overLimitUnicode = '界'.repeat(Math.ceil(ABSOLUTE_DIFF_BYTES / 3) + 1);
  assert.ok(overLimitUnicode.length < ABSOLUTE_DIFF_BYTES);
  assert.ok(Buffer.byteLength(overLimitUnicode) > ABSOLUTE_DIFF_BYTES);

  const result = await executeReview({
    centralRoot: path.resolve('.'),
    callerRoot,
    repository: 'org/repo',
    diff: overLimitUnicode,
    policy,
    policySha256,
    executable: '/must-not-spawn/claude',
    ripgrepExecutable: '/must-not-spawn/rg',
    sandboxExecutable: '/must-not-spawn/bwrap',
    environment: { PATH: process.env.PATH },
  });

  assert.equal(result.review.decision, 'infrastructure_failure');
  assert.match(result.review.failures[0].error, new RegExp(`exceeds the ${ABSOLUTE_DIFF_BYTES} byte review ceiling`));
});

test('honours an explicit maxDiffBytes ceiling instead of the built-in default', async () => {
  const { callerRoot } = await fixture();
  const ceiling = 4096;
  // Comfortably under ABSOLUTE_DIFF_BYTES, so if the override were ignored this diff would sail
  // through the size gate and the assertion below would fail - which is what makes this a test of
  // the override rather than a second test of the default.
  const diff = 'x'.repeat(ceiling + 1);
  assert.ok(Buffer.byteLength(diff) < ABSOLUTE_DIFF_BYTES);

  const result = await executeReview({
    centralRoot: path.resolve('.'),
    callerRoot,
    repository: 'org/repo',
    diff,
    maxDiffBytes: ceiling,
    policy,
    policySha256,
    executable: '/must-not-spawn/claude',
    ripgrepExecutable: '/must-not-spawn/rg',
    sandboxExecutable: '/must-not-spawn/bwrap',
    environment: { PATH: process.env.PATH },
  });

  assert.equal(result.review.decision, 'infrastructure_failure');
  assert.match(result.review.failures[0].error, new RegExp(`exceeds the ${ceiling} byte review ceiling`));
  // The refusal must say it is a refusal. Both a size refusal and a genuine outage surface as
  // decision=infrastructure_failure, and reading one as the other is what left PR #1315 classified
  // as "engine never judged, retry later" when no retry could ever have helped.
  assert.match(result.review.failures[0].error, /size refusal, not an engine failure/);
});

test('rejects a reported diff byte length below the supplied UTF-8 bytes before spawning Claude', async () => {
  const { callerRoot } = await fixture();
  const diff = '界x';

  const result = await executeReview({
    centralRoot: path.resolve('.'),
    callerRoot,
    repository: 'org/repo',
    diff,
    diffByteLength: Buffer.byteLength(diff) - 1,
    policy,
    policySha256,
    executable: '/must-not-spawn/claude',
    ripgrepExecutable: '/must-not-spawn/rg',
    sandboxExecutable: '/must-not-spawn/bwrap',
    environment: { PATH: process.env.PATH },
  });

  assert.equal(result.review.decision, 'infrastructure_failure');
  assert.match(result.review.failures[0].error, /no smaller than the supplied diff bytes/);
});

test('run-review emits a verifiable infrastructure artifact without reading an absolute-limit diff', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'run-review-limit-'));
  const callerRoot = path.join(root, 'caller');
  const outputDirectory = path.join(root, 'output');
  const contextPath = path.join(root, 'context.json');
  const policyPath = path.join(root, 'policy.json');
  const diffPath = path.join(root, 'review.diff');
  const baseOid = 'b'.repeat(40);
  const headOid = 'a'.repeat(40);
  const workflowRef = 'c'.repeat(40);
  const context = { repository: 'org/repo', pullNumber: 7, baseOid, headOid };
  await mkdir(callerRoot);
  await mkdir(outputDirectory);
  await writeFile(contextPath, JSON.stringify(context));
  await writeFile(policyPath, JSON.stringify(policy));
  await writeFile(diffPath, 'x'.repeat(ABSOLUTE_DIFF_BYTES + 1));

  const result = await runNode([path.resolve('src/run-review.mjs')], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      CENTRAL_ROOT: path.resolve('.'),
      CALLER_ROOT: callerRoot,
      REPOSITORY: 'org/repo',
      POLICY_FILE: policyPath,
      DIFF_PATH: diffPath,
      CONTEXT_PATH: contextPath,
      OUTPUT_DIRECTORY: outputDirectory,
      WORKFLOW_REF: workflowRef,
      REVIEW_HEAD_OID: headOid,
      GITHUB_RUN_ID: '123',
      GITHUB_RUN_ATTEMPT: '1',
      CLAUDE_EXECUTABLE: '/must-not-spawn/claude',
      RIPGREP_EXECUTABLE: '/must-not-spawn/rg',
      BWRAP_EXECUTABLE: '/must-not-spawn/bwrap',
      MAX_DIFF_CHARS: '40000',
      MAX_SHARD_CHARS: '12000',
      WORKER_TIMEOUT_MS: '120000',
      SHADOW: 'true',
    },
  });
  assert.equal(result.code, 2, result.stderr);
  const reviewJson = await readFile(path.join(outputDirectory, 'review.json'), 'utf8');
  const reviewMarkdown = await readFile(path.join(outputDirectory, 'review.md'), 'utf8');
  const manifest = JSON.parse(await readFile(path.join(outputDirectory, 'manifest.json'), 'utf8'));
  const review = JSON.parse(reviewJson);
  assert.equal(review.decision, 'infrastructure_failure');
  assert.match(review.failures[0].error, new RegExp(`exceeds the ${ABSOLUTE_DIFF_BYTES} byte review ceiling`));
  assert.equal(verifyManifest(manifest, context, {
    'review.json': reviewJson,
    'review.md': reviewMarkdown,
  }, {
    runId: 123,
    runAttempt: 1,
    workflowRef,
    policySha256: createHash('sha256').update(JSON.stringify(policy)).digest('hex'),
  }), true);
});

test('rejects malformed and legacy project policies before spawning Claude', async () => {
  const { callerRoot, executable } = await fixture();
  const invoke = (candidatePolicy) => executeReview({
    centralRoot: path.resolve('.'), callerRoot, repository: 'org/repo', diff: '', policy: candidatePolicy, policySha256, executable,
    environment: { PATH: process.env.PATH },
  });
  await assert.rejects(() => invoke({ ...policy, project: 'other/repo' }), /project/);
  await assert.rejects(() => invoke({ ...policy, version: 'project-review-policy.v1' }), /unsupported policy version/);
  const legacyRule = { ...policy, version: 'project-review-policy.v1', rules: [{ id: 'legacy', severity: 'major', text: 'legacy' }] };
  await assert.rejects(() => invoke(legacyRule), /unsupported policy version|v2 contract/);
  await assert.rejects(
    () => invoke({ ...policy, rules: [{ id: 'extra', level: 'suggestion', text: 'advisory', extra: true }] }),
    /fields do not match the v2 contract/,
  );
  await assert.rejects(
    () => invoke({ ...policy, rules: [{ id: 'invalid', level: 'critical', text: 'invalid' }] }),
    /level is invalid/,
  );
});

test('renders infrastructure failures with collision-free code spans and no code verdict', () => {
  const markdown = renderReviewMarkdown({
    version: 'v2', decision: 'infrastructure_failure', findings: [], suggestions: [], omittedSuggestions: 0,
    failures: [{
      stage: 'validate:`x`',
      status: 'infra_error',
      error: 'five ``votes`` unavailable',
      diagnostic: '{"events":[{"detail":"```api_retry```","errorStatus":524}]}',
    }],
  }, { headOid: 'b'.repeat(40), policyVersion: 'project-review-policy.v2', policySha256 });
  assert.match(markdown, /infrastructure_failure/);
  assert.match(markdown, new RegExp(policySha256));
  assert.match(markdown, /No approval or code finding was inferred/);
  assert.ok(markdown.includes('`` validate:`x` ``'));
  assert.ok(markdown.includes('``` five ``votes`` unavailable ```'));
  assert.ok(markdown.includes('```` {"events":[{"detail":"```api_retry```","errorStatus":524}]} ````'));
});

test('bounds public failure artifacts without changing the fail-closed decision', () => {
  const failures = Array.from({ length: 700 }, (_, index) => ({
    stage: index === 0 ? '   ' : `find:dimension-${index}:batch-0`,
    status: index % 2 === 0 ? 'schema_error' : 'infra_error',
    error: index === 0 ? '' : `failure-${index}-${'界'.repeat(2_000)}`,
    diagnostic: `diagnostic-${index}-${'诊'.repeat(2_000)}`,
  }));
  const publicFailures = compactReviewFailures(failures);
  const review = compactFinalReview({
    version: 'v2', decision: 'infrastructure_failure', findings: [], suggestions: [], omittedSuggestions: 0, failures: publicFailures,
  });
  assert.ok(review.failures.length <= 512);
  assert.equal(review.failures[0].stage, 'unknown-stage');
  assert.equal(review.failures[0].error, 'runner returned no result');
  assert.equal(review.failures.at(-1).stage, 'failure-report');
  assert.match(review.failures.at(-1).error, /of 700 omitted/);
  assert.match(review.failures.at(-1).error, /infra_error=/);
  assert.match(review.failures.at(-1).error, /schema_error=/);
  assert.match(review.failures.at(-1).error, /decision remains infrastructure_failure/);
  assert.ok(Buffer.byteLength(`${JSON.stringify(review, null, 2)}\n`) <= MAX_REVIEW_JSON_BYTES);

  const compactedMarkdown = renderReviewMarkdown(review, {
    headOid: 'b'.repeat(40), policyVersion: 'project-review-policy.v2', policySha256,
  });
  assert.ok(Buffer.byteLength(compactedMarkdown) <= MAX_REVIEW_MARKDOWN_BYTES);
  assert.match(compactedMarkdown, /omitted to stay within the publication budget/);
  assert.match(compactedMarkdown, /decision remains infrastructure_failure/);
});

test('falls back safely when validated findings exceed artifact publication budgets', () => {
  const findings = Array.from({ length: 128 }, (_, index) => ({
    taxonomy: 'correctness',
    path: `src/${'界'.repeat(490)}-${index}.mjs`,
    line: index + 1,
    title: `title-${index}-${'题'.repeat(160)}`,
    evidence: `evidence-${index}-${'证'.repeat(5_900)}`,
    rootCause: `root-${index}-${'因'.repeat(1_900)}`,
    level: 'major',
    fingerprint: index.toString(16).padStart(64, '0'),
  }));
  const review = compactFinalReview({
    version: 'v2', decision: 'request_changes', findings, suggestions: [], omittedSuggestions: 0, failures: [],
  });
  assert.equal(review.decision, 'infrastructure_failure');
  assert.deepEqual(review.findings, []);
  assert.deepEqual(review.suggestions, []);
  assert.equal(review.omittedSuggestions, 0);
  assert.equal(review.failures[0].stage, 'artifact-budget');
  assert.ok(Buffer.byteLength(`${JSON.stringify(review, null, 2)}\n`) <= MAX_REVIEW_JSON_BYTES);

  const markdown = renderReviewMarkdown(review, {
    headOid: 'h'.repeat(200_000),
    policyVersion: 'p'.repeat(200_000),
    policySha256: 's'.repeat(200_000),
  });
  assert.ok(Buffer.byteLength(markdown) <= MAX_REVIEW_MARKDOWN_BYTES);
  assert.match(markdown, /infrastructure_failure/);
  assert.match(markdown, /No approval or code finding was inferred/);
});

test('keeps Markdown decision aligned with a normal JSON verdict when detail sections exceed the byte budget', () => {
  const findings = Array.from({ length: 10 }, (_, index) => ({
    taxonomy: 'correctness',
    path: `src/a-${index}.mjs`,
    line: index + 1,
    title: `Validated defect ${index}`,
    evidence: `evidence-${index}-${'证'.repeat(5_850)}`,
    rootCause: `root-cause-${index}`,
    level: 'major',
    fingerprint: index.toString(16).padStart(64, '0'),
  }));
  const review = compactFinalReview({
    version: 'v2',
    decision: 'request_changes',
    findings,
    suggestions: [{
      ...findings[0],
      level: 'suggestion',
      fingerprint: 'f'.repeat(64),
    }],
    omittedSuggestions: 3,
    failures: [],
  });
  assert.equal(review.decision, 'request_changes');

  const markdown = renderReviewMarkdown(review, {
    headOid: 'a'.repeat(40),
    policyVersion: 'project-review-policy.v2',
    policySha256,
  });
  assert.ok(Buffer.byteLength(markdown) <= MAX_REVIEW_MARKDOWN_BYTES);
  assert.match(markdown, /\*\*Decision:\*\* ` request_changes `/);
  assert.doesNotMatch(markdown, /\*\*Decision:\*\* ` infrastructure_failure `/);
});

test('fails closed on contradictory final review decisions', () => {
  const finding = {
    taxonomy: 'correctness', path: 'src/a.mjs', line: 1, title: 'Title', evidence: 'Evidence',
    rootCause: 'Cause', level: 'major', fingerprint: 'a'.repeat(64),
  };
  for (const contradictory of [
    {
      version: 'v2', decision: 'approve', findings: [finding],
      suggestions: [], omittedSuggestions: 0, failures: [],
    },
    {
      version: 'v2', decision: 'request_changes', findings: [],
      suggestions: [], omittedSuggestions: 0, failures: [],
    },
    {
      version: 'v2', decision: 'infrastructure_failure', findings: [],
      suggestions: [], omittedSuggestions: 0, failures: [],
    },
  ]) {
    const compacted = compactFinalReview(contradictory);
    assert.equal(compacted.decision, 'infrastructure_failure');
    assert.equal(compacted.failures[0].stage, 'artifact-budget');
  }

  assert.equal(compactFinalReview({
    version: 'v2', decision: 'approve', findings: [{ ...finding, level: 'minor' }],
    suggestions: [], omittedSuggestions: 0, failures: [],
  }).decision, 'approve');
  assert.equal(compactFinalReview({
    version: 'v2', decision: 'request_changes', findings: [{ ...finding, level: 'minor' }],
    suggestions: [], omittedSuggestions: 0, failures: [],
  }).decision, 'request_changes');
  assert.equal(compactFinalReview({
    version: 'v2', decision: 'request_changes', findings: [finding],
    suggestions: [], omittedSuggestions: 0, failures: [],
  }).decision, 'request_changes');
});

test('fails closed when final-review item cardinality exceeds the schema contract', () => {
  const finding = {
    taxonomy: 'correctness', path: 'src/a.mjs', line: 1, title: 'Title', evidence: 'Evidence',
    rootCause: 'Cause', level: 'minor', fingerprint: 'a'.repeat(64),
  };
  const tooManyFindings = compactFinalReview({
    version: 'v2', decision: 'approve', findings: Array.from({ length: 129 }, () => finding),
    suggestions: [], omittedSuggestions: 0, failures: [],
  });
  assert.equal(tooManyFindings.decision, 'infrastructure_failure');
  assert.equal(tooManyFindings.failures[0].stage, 'artifact-budget');

  const failure = { stage: 'find:test', status: 'schema_error', error: 'invalid candidate' };
  const tooManyFailures = compactFinalReview({
    version: 'v2', decision: 'infrastructure_failure', findings: [], suggestions: [], omittedSuggestions: 0,
    failures: Array.from({ length: 513 }, () => failure),
  });
  assert.equal(tooManyFailures.decision, 'infrastructure_failure');
  assert.ok(tooManyFailures.failures.length <= 512);
  assert.equal(tooManyFailures.failures.at(-1).stage, 'failure-report');
});
