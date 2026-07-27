import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createClaudeRunner } from '../src/claude-runner.mjs';

const fingerprint = 'a'.repeat(64);
const centralRoot = path.resolve('.');

async function fakeStageClaude(root, data, name = 'fake-stage.mjs') {
  const executable = path.join(root, name);
  await writeFile(executable, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: 'result', structured_output: ${JSON.stringify(data)} }) + '\\n');
`);
  await chmod(executable, 0o755);
  return executable;
}

async function runStage(request, data) {
  const root = await mkdtemp(path.join(tmpdir(), `claude-runner-${request.stage}-`));
  const callerRoot = path.join(root, 'repository');
  await mkdir(callerRoot);
  const executable = await fakeStageClaude(root, data);
  const runner = createClaudeRunner({
    centralRoot,
    callerRoot,
    policy: { version: 'project-review-policy.v2' },
    repository: 'org/repo',
    environment: { PATH: process.env.PATH },
    executable,
    ripgrepExecutable: executable,
  });
  return runner.run(request);
}

async function runVote(vote) {
  return runStage({
    stage: 'validate',
    model: 'terra',
    candidate: { fingerprint, validationCandidates: [{ fingerprint }] },
    relatedDiff: 'diff --git a/src/a.mjs b/src/a.mjs\n',
  }, {
    version: 'v2',
    candidateFingerprint: fingerprint,
    level: 'major',
    evidence: 'checked the reachable production path',
    reason: 'independent validator result',
    ...vote,
  });
}

test('accepts only complete v2 level votes and reachable confirmations', async () => {
  assert.equal((await runVote({ verdict: 'confirm', reachable: true })).status, 'ok');
  assert.equal((await runVote({ verdict: 'confirm', reachable: false })).status, 'schema_error');
  assert.equal((await runVote({ verdict: 'reject', reachable: false, level: 'suggestion' })).status, 'ok');
  assert.equal((await runVote({ verdict: 'split', reachable: false, level: 'suggestion' })).status, 'ok');
  assert.equal((await runVote({ verdict: 'split', reachable: true, level: 'suggestion' })).status, 'schema_error');
  assert.equal((await runVote({ verdict: 'split', reachable: false, level: 'major' })).status, 'schema_error');
  assert.equal((await runVote({ verdict: 'reject', reachable: false, level: 'major' })).status, 'schema_error');
  assert.equal((await runVote({ verdict: 'reject', reachable: true, level: 'suggestion' })).status, 'schema_error');
  assert.equal((await runVote({ verdict: 'reject', reachable: false, level: undefined })).status, 'schema_error');
  assert.equal((await runVote({ verdict: 'reject', reachable: false, level: 'critical' })).status, 'schema_error');
  assert.equal((await runVote({ verdict: 'reject', reachable: false, version: 'v1' })).status, 'schema_error');
  assert.equal((await runVote({ verdict: 'reject', reachable: false, extra: true })).status, 'schema_error');
});

async function runFinder(data, taxonomy = 'security') {
  return runStage({
    stage: 'find', model: 'terra', taxonomy, paths: ['src/a.mjs'], diff: 'diff', summaries: [],
  }, data);
}

const completeCandidate = {
  version: 'v2', taxonomy: 'security', path: 'src/a.mjs', line: 1,
  title: 'Missing guard', evidence: 'reachable route', rootCause: 'authorization is absent', level: 'major',
};

test('finder accepts only complete clean-v2 candidates', async () => {
  assert.equal((await runFinder([])).status, 'ok');
  assert.equal((await runFinder([completeCandidate])).status, 'ok');
  for (const field of Object.keys(completeCandidate)) {
    const malformed = { ...completeCandidate };
    delete malformed[field];
    assert.equal((await runFinder([malformed])).status, 'schema_error', `missing ${field}`);
  }
  const legacy = { ...completeCandidate, version: 'v1', severity: completeCandidate.level };
  delete legacy.level;
  for (const malformed of [
    { ...completeCandidate, extra: true },
    { ...completeCandidate, version: 'v1' },
    legacy,
    { ...completeCandidate, taxonomy: 'correctness' },
    { ...completeCandidate, level: 'critical' },
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

test('consolidator accepts only an exhaustive same-path partition', async () => {
  const secondFingerprint = 'b'.repeat(64);
  const candidates = [
    {
      fingerprint,
      path: 'src/a.mjs',
      rootCause: 'first cause',
      provenance: [{ evidence: 'first' }],
    },
    {
      fingerprint: secondFingerprint,
      path: 'src/a.mjs',
      rootCause: 'second cause',
      provenance: [{ evidence: 'second' }],
    },
  ];
  const request = { stage: 'consolidate', model: 'sol', candidates };
  const valid = {
    version: 'v2',
    clusters: [{
      representativeFingerprint: fingerprint,
      memberFingerprints: [fingerprint, secondFingerprint],
    }],
  };
  assert.equal((await runStage(request, valid)).status, 'ok');
  assert.equal((await runStage(request, {
    version: 'v2',
    clusters: [{ representativeFingerprint: fingerprint, memberFingerprints: [fingerprint] }],
  })).status, 'schema_error');
  assert.equal((await runStage(request, { ...valid, extra: true })).status, 'schema_error');
  assert.equal((await runStage(request, { ...valid, version: 'v1' })).status, 'schema_error');
});

test('adjudicator requires v2 and a final level for accept', async () => {
  const request = {
    stage: 'adjudicate', model: 'sol', candidate: { fingerprint }, voteRounds: [],
  };
  const base = {
    version: 'v2', candidateFingerprint: fingerprint, decision: 'accept', reason: 'defect survives refutation',
  };
  assert.equal((await runStage(request, { ...base, level: 'major' })).status, 'ok');
  assert.equal((await runStage(request, base)).status, 'schema_error');
  assert.equal((await runStage(request, { ...base, level: 'critical' })).status, 'schema_error');
  assert.equal((await runStage(request, { ...base, version: 'v1', level: 'major' })).status, 'schema_error');
  assert.equal((await runStage(request, { ...base, decision: 'reject' })).status, 'ok');
});

test('prompts lock clean v2, independent level voting, and no partial candidates', async () => {
  const source = await readFile(path.resolve('src/claude-runner.mjs'), 'utf8');
  assert.match(source, /Every finding requires version v2/);
  assert.match(source, /Never emit a partial candidate/);
  assert.match(source, /return \[\] when no complete candidate qualifies/);
  assert.match(source, /Independently assign the impact level/);
  assert.match(source, /Do not defer to the finder-proposed level/);
  assert.match(source, /Every supplied fingerprint must appear exactly once/);
  assert.match(source, /Use split only when two or more members describe independent defects/);
  assert.match(source, /Reject only when the cluster is structurally coherent/);
  assert.match(source, /used only after three complete existence-split rounds with no structural split votes/);
  assert.match(source, /suggestion: no demonstrable wrong result/);
});
