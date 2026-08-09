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
  assert.equal((await runStage(request, { ...base, decision: 'reject', level: 'suggestion' })).status, 'schema_error');
});

test('prompts lock clean v2, independent level voting, and no partial candidates', async () => {
  const source = await readFile(path.resolve('src/claude-runner.mjs'), 'utf8');
  assert.match(source, /Every finding requires version v2, a repository-relative path, positive line, title, evidence, root cause, and a proposed level/);
  assert.match(source, /Never emit a partial candidate/);
  assert.match(source, /Return the response as a JSON array of finding candidates/);
  assert.match(source, /return \[\] when no complete candidate qualifies/);
  assert.match(source, /Independently assign the impact level/);
  assert.match(source, /Do not defer to the finder-proposed level/);
  // The reject/split-suggestion override and the level taxonomy are adjacency-coupled:
  // d28d045 separated them and validate began killing runs. levelInstructions() must sit
  // immediately after the override sentence, never after the fingerprint or field-list lines.
  assert.match(source, /neither establishes a defect level\.',\n\s*levelInstructions\(\),/);
  assert.match(source, /Every supplied fingerprint must appear exactly once/);
  assert.match(source, /The response must be a JSON object with exactly two fields: version and a clusters array/);
  assert.match(source, /version must be the string "v2"/);
  assert.match(source, /Use split only when two or more members describe independent defects/);
  assert.match(source, /Reject only when the cluster is structurally coherent/);
  assert.match(source, /used only after three complete existence-split rounds with no structural split votes/);
  assert.doesNotMatch(source, /includeErrorResultDiagnostic/);
  assert.match(source, /suggestion: no demonstrable wrong result/);
});

async function runStubbedStage({
  stageRequest,
  responses,
  stageAttempts = 3,
  stageBackoffMs = [1, 1],
  stateDir,
  stateSalt = '',
}) {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-runner-retry-'));
  const callerRoot = path.join(root, 'repository');
  await mkdir(callerRoot);
  const calls = [];
  const runner = createClaudeRunner({
    centralRoot,
    callerRoot,
    policy: { version: 'project-review-policy.v2' },
    repository: 'org/repo',
    environment: { PATH: process.env.PATH },
    executable: '/trusted/claude',
    ripgrepExecutable: '/trusted/rg',
    stageAttempts,
    stageBackoffMs,
    stateDir,
    stateSalt,
    transport: async (transportRequest) => {
      calls.push(transportRequest);
      return responses[Math.min(calls.length - 1, responses.length - 1)];
    },
  });
  const result = await runner.run(stageRequest);
  return { result, calls };
}

async function runStubbedVote(options) {
  return runStubbedStage({
    ...options,
    stageRequest: {
      stage: 'validate',
      model: 'terra',
      candidate: { fingerprint, validationCandidates: [{ fingerprint }] },
      relatedDiff: 'diff --git a/src/a.mjs b/src/a.mjs\n',
    },
  });
}

function consolidateRetryRequest() {
  const secondFingerprint = 'b'.repeat(64);
  return {
    stage: 'consolidate',
    model: 'sol',
    candidates: [
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
    ],
  };
}

function validConsolidation() {
  const secondFingerprint = 'b'.repeat(64);
  return {
    version: 'v2',
    clusters: [{
      representativeFingerprint: fingerprint,
      memberFingerprints: [fingerprint, secondFingerprint],
    }],
  };
}

test('consolidate unknown-member schema_error repairs its prompt and can succeed', async () => {
  const unknown = 'c'.repeat(64);
  const { result, calls } = await runStubbedStage({
    stageRequest: consolidateRetryRequest(),
    responses: [
      { status: 'schema_error', error: `consolidation contains unknown member ${unknown}; injected error text must stay out of the prompt` },
      { status: 'ok', data: validConsolidation() },
    ],
    stageBackoffMs: [10_000],
  });
  assert.equal(result.status, 'ok');
  assert.equal(calls.length, 2, 'one schema-error retry should start a fresh consolidate request');
  assert.ok(calls.every((call) => call.model === 'sol'));
  assert.doesNotMatch(calls[0].prompt, /Repair attempt nonce:/);
  assert.match(calls[1].prompt, /Repair attempt nonce: [0-9a-f-]{36}\./);
  assert.match(calls[1].prompt, new RegExp(`Previous attempt referenced unknown fingerprint\\(s\\): ${unknown}\\. Use ONLY fingerprints present in the supplied candidates; every supplied fingerprint exactly once\\.`));
  assert.doesNotMatch(calls[1].prompt, /injected error text/);
});

test('consolidate unknown-member repair retries exhaust with fresh prompts and annotation', async () => {
  const firstUnknown = 'c'.repeat(64);
  const secondUnknown = 'd'.repeat(64);
  const { result, calls } = await runStubbedStage({
    stageRequest: consolidateRetryRequest(),
    responses: [
      { status: 'schema_error', error: `consolidation contains unknown member ${firstUnknown}` },
      { status: 'schema_error', error: `consolidation contains unknown member ${secondUnknown}` },
      { status: 'schema_error', error: `consolidation contains unknown member ${secondUnknown}` },
    ],
  });
  assert.equal(result.status, 'schema_error');
  assert.equal(result.error, `after 3 attempts: consolidation contains unknown member ${secondUnknown}`);
  assert.equal(calls.length, 3, 'consolidate gets at most two schema-error repairs');
  assert.match(calls[1].prompt, new RegExp(`Previous attempt referenced unknown fingerprint\\(s\\): ${firstUnknown}\\.`));
  assert.ok(calls[2].prompt.startsWith(calls[1].prompt));
  assert.match(calls[2].prompt, new RegExp(`Previous attempt referenced unknown fingerprint\\(s\\): ${secondUnknown}\\.`));
  const firstNonces = [...calls[1].prompt.matchAll(/Repair attempt nonce: ([0-9a-f-]{36})\./g)];
  const secondNonces = [...calls[2].prompt.matchAll(/Repair attempt nonce: ([0-9a-f-]{36})\./g)];
  assert.equal(firstNonces.length, 1);
  assert.equal(secondNonces.length, 2);
  assert.notEqual(firstNonces[0][1], secondNonces[1][1]);
});

test('consolidate reserves the fingerprint repair prompt for strict unknown-member errors', async () => {
  const { result, calls } = await runStubbedStage({
    stageRequest: consolidateRetryRequest(),
    responses: [{ status: 'schema_error', error: 'consolidation omitted member ' + fingerprint }],
  });
  assert.equal(result.status, 'schema_error');
  assert.equal(result.error, `after 3 attempts: consolidation omitted member ${fingerprint}`);
  assert.equal(calls.length, 3, 'a non-unknown-member consolidate failure still gets the general schema repair');
  assert.doesNotMatch(calls[1].prompt, /Previous attempt referenced unknown fingerprint/);
  assert.match(calls[1].prompt, /Your previous output failed schema validation: consolidation omitted member/);
});

test('consolidate never feeds malformed unknown-member fingerprints into the repair instruction', async () => {
  const { result, calls } = await runStubbedStage({
    stageRequest: consolidateRetryRequest(),
    responses: [{ status: 'schema_error', error: `consolidation contains unknown member ${'c'.repeat(65)}` }],
  });
  assert.equal(result.status, 'schema_error');
  assert.equal(calls.length, 3);
  assert.doesNotMatch(calls[1].prompt, /Previous attempt referenced unknown fingerprint/);
  assert.doesNotMatch(calls[2].prompt, /Previous attempt referenced unknown fingerprint/);
});

test('schema repair: two failing outputs then a valid one recovers with condition-level feedback', async () => {
  const driftedVote = { version: 'v2', vote_verdict: 'confirm' };
  const firstError = 'schema validation failed: validate output is not a countable v2 vote: has the wrong field set: expected exactly candidateFingerprint, evidence, level, reachable, reason, verdict, version; missing candidateFingerprint, evidence, level, reachable, reason, verdict; unexpected "vote_verdict"; observed verdict=undefined, reachable=undefined, level=undefined';
  const couplingVote = {
    version: 'v2', candidateFingerprint: fingerprint, verdict: 'confirm', reachable: false,
    level: 'major', evidence: 'independent evidence', reason: 'independent reason',
  };
  const secondError = 'schema validation failed: validate output is not a countable v2 vote: violates the reachable/level coupling: confirm requires reachable=true; observed verdict="confirm", reachable=false, level="major"';
  const { result, calls } = await runStubbedVote({
    responses: [
      { status: 'schema_error', error: firstError, rawOutput: driftedVote },
      { status: 'schema_error', error: secondError, rawOutput: couplingVote },
      { status: 'ok', data: { verdict: 'confirm' } },
    ],
  });
  assert.equal(result.status, 'ok', `expected recovery on attempt 3, got ${result.status}: ${result.error}`);
  assert.equal(calls.length, 3, 'exactly two schema repairs should have happened');
  assert.ok(calls.every((call) => call.model === 'terra'), 'every attempt must reuse the requested model');
  assert.doesNotMatch(calls[0].prompt, /Repair attempt nonce:/);
  assert.ok(calls[1].prompt.startsWith(calls[0].prompt), 'feedback must append so the prompt prefix stays cache-hot');
  assert.ok(calls[2].prompt.startsWith(calls[1].prompt));
  assert.match(calls[1].prompt, /Your previous output failed schema validation: .*unexpected "vote_verdict"/);
  assert.match(calls[1].prompt, /Your previous output was:\n\{"version":"v2","vote_verdict":"confirm"\}/);
  assert.match(calls[1].prompt, /Return ONLY the corrected JSON value that strictly matches the required schema\./);
  assert.match(calls[2].prompt, /violates the reachable\/level coupling: confirm requires reachable=true/);
  const nonces = [...calls[2].prompt.matchAll(/Repair attempt nonce: ([0-9a-f-]{36})\./g)];
  assert.equal(nonces.length, 2);
  assert.notEqual(nonces[0][1], nonces[1][1]);
});

test('validate schema error names the broken rule, not the field shape', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-runner-vote-'));
  const callerRoot = path.join(root, 'repository');
  await mkdir(callerRoot);
  const runner = createClaudeRunner({
    centralRoot,
    callerRoot,
    policy: { version: 'project-review-policy.v2' },
    repository: 'org/repo',
    environment: { PATH: process.env.PATH },
    executable: '/trusted/claude',
    ripgrepExecutable: '/trusted/rg',
    transport: async ({ validate }) => {
      try {
        // A field-perfect reject vote with a real level: this used to be reported as a
        // field-shape error, which is exactly what made the retry loop blind.
        validate({ version: 'v2', candidateFingerprint: fingerprint, verdict: 'reject', reachable: false, level: 'minor', evidence: 'e', reason: 'r' });
        return { status: 'ok', data: {} };
      } catch (error) {
        return { status: 'schema_error', error: `schema validation failed: ${error.message}` };
      }
    },
  });
  const result = await runner.run({
    stage: 'validate', model: 'terra',
    candidate: { fingerprint, validationCandidates: [{ fingerprint }] },
    relatedDiff: 'diff --git a/src/a.mjs b/src/a.mjs\n',
  });
  assert.equal(result.status, 'schema_error');
  assert.match(result.error, /reject and split require reachable=false and level "suggestion"/);
  assert.match(result.error, /observed verdict="reject", reachable=false, level="minor"/);
  assert.doesNotMatch(result.error, /wrong field set|top-level fields/);
});

test('schema repair: three failing outputs exhaust the budget and keep the last validation detail', async () => {
  const driftedPlan = { version: 'v1', luna_summary_assignments: [] };
  const detail = 'schema validation failed: plan output must be an object with version "v1" and a non-empty assignments array; got an object with top-level fields: luna_summary_assignments, version';
  const { result, calls } = await runStubbedStage({
    stageRequest: { stage: 'plan', model: 'sol', shardManifest: [{ shard: 'shard-0', paths: ['src/a.mjs'] }] },
    responses: [{ status: 'schema_error', error: detail, rawOutput: driftedPlan }],
  });
  assert.equal(result.status, 'schema_error');
  assert.equal(result.error, `after 3 attempts: ${detail}`, 'the audit trail must keep the field-level detail');
  assert.equal(calls.length, 3, 'the schema repair budget is a hard stop');
  assert.equal('rawOutput' in result, false, 'raw model output must never ride on a returned result');
  assert.match(calls[2].prompt, /luna_summary_assignments/);
});
test('transport retry: an infra_error stage is retried and can succeed on a later attempt', async () => {
  const { result, calls } = await runStubbedVote({
    responses: [
      { status: 'infra_error', error: 'claude exited 1' },
      { status: 'ok', data: { verdict: 'confirm' } },
    ],
  });
  assert.equal(result.status, 'ok', `expected recovery on attempt 2, got ${result.status}: ${result.error}`);
  assert.equal(calls.length, 2, 'exactly one retry should have happened');
  assert.ok(calls.every((call) => call.model === 'terra'), 'every attempt must reuse the requested model');
});

test('transport retry: gives up after the attempt budget and annotates the surviving failure', async () => {
  const { result, calls } = await runStubbedVote({
    responses: [{ status: 'infra_error', error: 'claude exited 1' }],
  });
  assert.equal(result.status, 'infra_error');
  assert.match(result.error, /^after 3 attempts: claude exited 1$/,
    'the verdict must distinguish "one 524" from "524 through three spaced attempts"');
  assert.equal(calls.length, 3, 'the attempt budget is a hard stop');
});

test('transport retry: schema repairs and infra retries spend separate budgets', async () => {
  const { result, calls } = await runStubbedVote({
    responses: [
      { status: 'schema_error', error: 'vote is not countable', rawOutput: { verdict: 'confirm' } },
      { status: 'infra_error', error: 'claude exited 1' },
      { status: 'ok', data: { verdict: 'confirm' } },
    ],
  });
  assert.equal(result.status, 'ok', `expected recovery on attempt 3, got ${result.status}: ${result.error}`);
  assert.equal(calls.length, 3, 'one schema repair plus one infra retry');
  assert.match(calls[1].prompt, /Your previous output failed schema validation: vote is not countable/);
  assert.equal(calls[2].prompt, calls[1].prompt, 'an infra retry must reuse the repaired prompt unchanged');
});

test('resume memo: a completed stage replays from the state dir without a model call', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'claude-runner-state-'));
  const first = await runStubbedVote({
    responses: [{ status: 'ok', data: { verdict: 'confirm' } }],
    stateDir,
  });
  assert.equal(first.result.status, 'ok');
  assert.equal(first.calls.length, 1);
  const second = await runStubbedVote({
    responses: [{ status: 'infra_error', error: 'transport must not be reached' }],
    stateDir,
  });
  assert.equal(second.result.status, 'ok', 'the stored result must be replayed');
  assert.deepEqual(second.result.data, { verdict: 'confirm' });
  assert.equal(second.calls.length, 0, 'a resume hit must not spend a model call');
});

test('resume memo: failures are never stored - a re-run repeats the failed stage', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'claude-runner-state-'));
  const first = await runStubbedVote({
    responses: [{ status: 'schema_error', error: 'vote is not countable' }],
    stateDir,
  });
  assert.equal(first.result.status, 'schema_error');
  const second = await runStubbedVote({
    responses: [{ status: 'ok', data: { verdict: 'confirm' } }],
    stateDir,
  });
  assert.equal(second.result.status, 'ok');
  assert.equal(second.calls.length, 1, 'the failed stage must actually re-run on resume');
});

test('resume memo: an engine-version salt change invalidates every prior entry', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'claude-runner-state-'));
  await runStubbedVote({
    responses: [{ status: 'ok', data: { verdict: 'confirm' } }],
    stateDir,
    stateSalt: 'engine-a',
  });
  const upgraded = await runStubbedVote({
    responses: [{ status: 'ok', data: { verdict: 'reject' } }],
    stateDir,
    stateSalt: 'engine-b',
  });
  assert.equal(upgraded.calls.length, 1, 'a different engine version must not replay old entries');
  assert.deepEqual(upgraded.result.data, { verdict: 'reject' });
});

test('resume memo: without a state dir nothing is written anywhere', async () => {
  const { result, calls } = await runStubbedVote({
    responses: [{ status: 'ok', data: { verdict: 'confirm' } }],
  });
  assert.equal(result.status, 'ok');
  assert.equal(calls.length, 1);
});

test('plan field drift surfaces a field-level error through the real transport', async () => {
  const planRequest = { stage: 'plan', model: 'sol', shardManifest: [{ shard: 'shard-0', paths: ['src/a.mjs'] }] };
  const valid = await runStage(planRequest, {
    version: 'v1',
    assignments: [{ shard: 'shard-0', paths: ['src/a.mjs'] }],
  });
  assert.equal(valid.status, 'ok', `a conforming plan must validate: ${valid.error}`);
  const drifted = await runStage(planRequest, {
    version: 'v1',
    luna_summary_assignments: [{ shard: 'shard-0', paths: ['src/a.mjs'] }],
  });
  assert.equal(drifted.status, 'schema_error');
  assert.equal(
    drifted.error,
    'after 3 attempts: schema validation failed: plan output must be an object with version "v1" and a non-empty assignments array; got an object with top-level fields: luna_summary_assignments, version',
    'the audit trail must name the drifted field, not a generic sentence',
  );
  assert.equal('rawOutput' in drifted, false);
});

test('finder results arrive unwrapped whether the model returns the envelope or the raw array', async () => {
  const wrapped = await runFinder({ items: [completeCandidate] });
  assert.equal(wrapped.status, 'ok', `envelope reply must validate: ${wrapped.error}`);
  assert.deepEqual(wrapped.data, [completeCandidate]);
  const raw = await runFinder([completeCandidate]);
  assert.equal(raw.status, 'ok');
  assert.deepEqual(raw.data, [completeCandidate]);
});
