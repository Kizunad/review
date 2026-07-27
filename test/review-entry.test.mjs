import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifyManifest } from '../src/artifact-manifest.mjs';
import { ABSOLUTE_DIFF_BYTES, MAX_REVIEW_JSON_BYTES, MAX_REVIEW_MARKDOWN_BYTES, compactFinalReview, compactReviewFailures, executeReview, renderReviewMarkdown } from '../src/review-entry.mjs';

const policy = {
  version: 'project-review-policy.v1',
  project: 'org/repo',
  rules: [{ id: 'canonical-contract', severity: 'major', text: 'Keep the canonical contract connected end to end.' }],
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
model=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = '--model' ]; then model="$2"; break; fi
  shift
done
case "$model" in
  sol) output='{"version":"v1","assignments":[{"id":"all","shardIndexes":[0]}]}' ;;
  luna) output='{"version":"v1","summary":"one changed file","files":["src/a.mjs"]}' ;;
  terra) output='[]' ;;
  *) exit 9 ;;
esac
printf '{"type":"result","structured_output":%s}\n' "$output"
`);
  await chmod(executable, 0o755);
  return { callerRoot, executable };
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
  assert.deepEqual(result.review.failures, []);
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
  assert.match(oversized.review.failures[0].error, new RegExp(`absolute ${ABSOLUTE_DIFF_BYTES} byte safety limit`));
});
test('rejects multibyte diffs above the byte limit before spawning Claude', async () => {
  const { callerRoot } = await fixture();
  const overLimitUnicode = '界'.repeat(349_526);
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
  assert.match(result.review.failures[0].error, new RegExp(`absolute ${ABSOLUTE_DIFF_BYTES} byte safety limit`));
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
  assert.match(review.failures[0].error, new RegExp(`absolute ${ABSOLUTE_DIFF_BYTES} byte safety limit`));
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

test('rejects malformed project policies before spawning Claude', async () => {
  const { callerRoot, executable } = await fixture();
  await assert.rejects(() => executeReview({
    centralRoot: path.resolve('.'), callerRoot, repository: 'org/repo', diff: '', policy: { ...policy, project: 'other/repo' }, policySha256, executable,
    environment: { PATH: process.env.PATH },
  }), /project/);
});

test('renders infrastructure failures with collision-free code spans and no code verdict', () => {
  const markdown = renderReviewMarkdown({
    version: 'v1', decision: 'infrastructure_failure', findings: [],
    failures: [{
      stage: 'validate:`x`',
      status: 'infra_error',
      error: 'five ``votes`` unavailable',
      diagnostic: '{"events":[{"detail":"```api_retry```","errorStatus":524}]}',
    }],
  }, { headOid: 'b'.repeat(40), policyVersion: 'project-review-policy.v1', policySha256 });
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
    version: 'v1', decision: 'infrastructure_failure', findings: [], failures: publicFailures,
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
    headOid: 'b'.repeat(40), policyVersion: 'project-review-policy.v1', policySha256,
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
    severity: 'major',
    fingerprint: index.toString(16).padStart(64, '0'),
  }));
  const review = compactFinalReview({
    version: 'v1', decision: 'request_changes', findings, failures: [],
  });
  assert.equal(review.decision, 'infrastructure_failure');
  assert.deepEqual(review.findings, []);
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

test('fails closed when final-review item cardinality exceeds the schema contract', () => {
  const finding = {
    taxonomy: 'correctness', path: 'src/a.mjs', line: 1, title: 'Title', evidence: 'Evidence',
    rootCause: 'Cause', severity: 'minor', fingerprint: 'a'.repeat(64),
  };
  const tooManyFindings = compactFinalReview({
    version: 'v1', decision: 'approve', findings: Array.from({ length: 129 }, () => finding), failures: [],
  });
  assert.equal(tooManyFindings.decision, 'infrastructure_failure');
  assert.equal(tooManyFindings.failures[0].stage, 'artifact-budget');

  const failure = { stage: 'find:test', status: 'schema_error', error: 'invalid candidate' };
  const tooManyFailures = compactFinalReview({
    version: 'v1', decision: 'infrastructure_failure', findings: [],
    failures: Array.from({ length: 513 }, () => failure),
  });
  assert.equal(tooManyFailures.decision, 'infrastructure_failure');
  assert.ok(tooManyFailures.failures.length <= 512);
  assert.equal(tooManyFailures.failures.at(-1).stage, 'failure-report');
});
