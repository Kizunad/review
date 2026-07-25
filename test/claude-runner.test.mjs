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
}));
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
