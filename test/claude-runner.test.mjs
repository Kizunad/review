import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createClaudeRunner } from '../src/claude-runner.mjs';

const fingerprint = 'a'.repeat(64);

async function fakeClaude(root, vote) {
  const executable = path.join(root, `fake-${vote.verdict}-${vote.reachable}.mjs`);
  await writeFile(executable, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  type: 'result',
  structured_output: ${JSON.stringify({
    version: 'v1',
    candidateFingerprint: fingerprint,
    evidence: 'checked the reachable production path',
    reason: 'independent validator result',
    ...vote,
  })},
}) + '\\n');
`);
  await chmod(executable, 0o755);
  return executable;
}

async function runVote(vote) {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-runner-vote-'));
  const callerRoot = path.join(root, 'repository');
  await (await import('node:fs/promises')).mkdir(callerRoot);
  const executable = await fakeClaude(root, vote);
  const runner = createClaudeRunner({
    centralRoot: path.resolve('.'),
    callerRoot,
    policy: { version: 'project-review-policy.v1' },
    repository: 'org/repo',
    environment: { PATH: process.env.PATH },
    executable,
    ripgrepExecutable: executable,
  });
  return runner.run({
    stage: 'validate',
    model: 'terra',
    candidate: { fingerprint },
    relatedDiff: 'diff --git a/src/a.mjs b/src/a.mjs\n',
  });
}

test('accepts only reachable confirmation votes while allowing defensive rejections', async () => {
  assert.equal((await runVote({ verdict: 'confirm', reachable: true })).status, 'ok');
  assert.equal((await runVote({ verdict: 'confirm', reachable: false })).status, 'schema_error');
  assert.equal((await runVote({ verdict: 'reject', reachable: false })).status, 'ok');
});

async function fakeStageClaude(root, data) {
  const executable = path.join(root, 'fake-stage.mjs');
  await writeFile(executable, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: 'result', structured_output: ${JSON.stringify(data)} }) + '\\n');
`);
  await chmod(executable, 0o755);
  return executable;
}

async function runFinder(data, taxonomy = 'security') {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-runner-find-'));
  const callerRoot = path.join(root, 'repository');
  await (await import('node:fs/promises')).mkdir(callerRoot);
  const executable = await fakeStageClaude(root, data);
  const runner = createClaudeRunner({
    centralRoot: path.resolve('.'),
    callerRoot,
    policy: { version: 'project-review-policy.v1' },
    repository: 'org/repo',
    environment: { PATH: process.env.PATH },
    executable,
    ripgrepExecutable: executable,
  });
  return runner.run({
    stage: 'find', model: 'terra', taxonomy, paths: ['src/a.mjs'], diff: 'diff', summaries: [],
  });
}

const completeCandidate = {
  version: 'v1', taxonomy: 'security', path: 'src/a.mjs', line: 1,
  title: 'Missing guard', evidence: 'reachable route', rootCause: 'authorization is absent', severity: 'major',
};

test('finder accepts only complete schema-equivalent candidates', async () => {
  assert.equal((await runFinder([])).status, 'ok');
  assert.equal((await runFinder([completeCandidate])).status, 'ok');
  for (const field of Object.keys(completeCandidate)) {
    const malformed = { ...completeCandidate };
    delete malformed[field];
    assert.equal((await runFinder([malformed])).status, 'schema_error', `missing ${field}`);
  }
  for (const malformed of [
    { ...completeCandidate, extra: true },
    { ...completeCandidate, version: 'v2' },
    { ...completeCandidate, taxonomy: 'correctness' },
    { ...completeCandidate, path: `src/${'x'.repeat(497)}` },
    { ...completeCandidate, title: 'x'.repeat(181) },
    { ...completeCandidate, evidence: 'x'.repeat(6_001) },
    { ...completeCandidate, rootCause: 'x'.repeat(2_001) },
    { ...completeCandidate, line: 0 },
  ]) {
    assert.equal((await runFinder([malformed])).status, 'schema_error');
  }
  assert.equal((await runFinder([{ ...completeCandidate, title: '😀'.repeat(180) }])).status, 'ok');
  assert.equal((await runFinder([{ ...completeCandidate, title: '😀'.repeat(181) }])).status, 'schema_error');
  assert.equal((await runFinder(Array.from({ length: 129 }, () => completeCandidate))).status, 'schema_error');
});

test('finder prompt tells Terra to omit partial candidates', async () => {
  const source = await (await import('node:fs/promises')).readFile(path.resolve('src/claude-runner.mjs'), 'utf8');
  assert.match(source, /Never emit a partial candidate/);
  assert.match(source, /return \[\] when no complete candidate qualifies/);
});
