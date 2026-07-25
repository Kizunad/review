import test from 'node:test';
import assert from 'node:assert/strict';
import { runReview } from '../src/orchestrator.mjs';

const finding = {
  taxonomy: 'security', path: 'src/a.mjs', line: 4, title: 'Missing guard', evidence: 'route is public', rootCause: 'no authorization', severity: 'major',
};

function runnerFor(handler) {
  return { run: async (request) => handler(request) };
}

function plan(assignments = [{ id: 'a', shardIndexes: [0] }]) {
  return { status: 'ok', data: { assignments }, transcript: 'never pass this' };
}

test('keeps all Sol output out of Terra input and accepts four confirmations', async () => {
  const requests = [];
  const result = await runReview({
    diff: 'diff --git a/a.mjs b/a.mjs\n', taxonomy: ['security'],
    runner: runnerFor((request) => {
      requests.push(request);
      if (request.stage === 'plan') return plan();
      if (request.stage === 'summary') return { status: 'ok', data: { summary: 'one file', files: ['a.mjs'] } };
      if (request.stage === 'find') return { status: 'ok', data: [finding] };
      if (request.stage === 'validate') return { status: 'ok', data: { verdict: request.validator === 4 ? 'reject' : 'confirm' } };
      throw new Error(`unexpected ${request.stage}`);
    }),
  });
  assert.equal(result.findings.length, 1);
  const finder = requests.find((request) => request.stage === 'find');
  assert.equal('plan' in finder, false);
  assert.equal('transcript' in finder, false);
  assert.deepEqual(finder.summaries, [{ assignment: 'a', data: { summary: 'one file', files: ['a.mjs'] } }]);
  assert.equal(requests.filter((request) => request.stage === 'validate').length, 5);
});

test('runs every Luna assignment and fills uncovered shards deterministically', async () => {
  const summaries = [];
  const diff = 'diff --git a/a b/a\n1234567890diff --git a/b b/b\nabcdefghij';
  await runReview({
    diff, taxonomy: ['security'], maxShardChars: 30,
    runner: runnerFor((request) => {
      if (request.stage === 'plan') return plan([{ id: 'first', shardIndexes: [0] }]);
      if (request.stage === 'summary') {
        summaries.push(request);
        return { status: 'ok', data: { summary: request.assignment.id, files: [] } };
      }
      if (request.stage === 'find') return { status: 'ok', data: [] };
      throw new Error(`unexpected ${request.stage}`);
    }),
  });
  assert.ok(summaries.length >= 2);
  assert.equal(summaries[0].model, 'luna');
  assert.ok(summaries.every((request) => !('plan' in request)));
});

test('retries split votes three times then sends only structured votes to Sol adjudication', async () => {
  const requests = [];
  const result = await runReview({
    diff: 'd', taxonomy: ['security'],
    runner: runnerFor((request) => {
      requests.push(request);
      if (request.stage === 'plan') return plan([]);
      if (request.stage === 'summary') return { status: 'ok', data: { summary: 's', files: [] } };
      if (request.stage === 'find') return { status: 'ok', data: [finding] };
      if (request.stage === 'validate') return { status: 'ok', data: { verdict: request.validator < 2 ? 'confirm' : 'reject' } };
      if (request.stage === 'adjudicate') return { status: 'ok', data: { decision: 'accept' } };
      throw new Error(`unexpected ${request.stage}`);
    }),
  });
  assert.equal(result.findings.length, 1);
  assert.equal(requests.filter((request) => request.stage === 'validate').length, 15);
  const adjudication = requests.find((request) => request.stage === 'adjudicate');
  assert.equal(adjudication.model, 'sol');
  assert.equal(adjudication.voteRounds.length, 3);
  assert.equal('summaries' in adjudication, false);
});

test('replaces failed validator seats until five valid votes are collected', async () => {
  let attempts = 0;
  const result = await runReview({
    diff: 'd', taxonomy: ['security'],
    runner: runnerFor((request) => {
      if (request.stage === 'plan') return plan([]);
      if (request.stage === 'summary') return { status: 'ok', data: { summary: 's', files: [] } };
      if (request.stage === 'find') return { status: 'ok', data: [finding] };
      if (request.stage === 'validate') {
        attempts += 1;
        if (attempts <= 2) return { status: 'infra_error', error: 'timeout' };
        return { status: 'ok', data: { verdict: attempts === 7 ? 'reject' : 'confirm' } };
      }
      throw new Error(`unexpected ${request.stage}`);
    }),
  });
  assert.equal(attempts, 7);
  assert.equal(result.findings.length, 1);
  assert.equal(result.failures.filter((failure) => failure.status === 'infra_error').length, 2);
});

test('fails infrastructure when five validator seats cannot be filled and never adjudicates', async () => {
  let adjudications = 0;
  const result = await runReview({
    diff: 'd', taxonomy: ['security'], maxValidatorAttempts: 5,
    runner: runnerFor((request) => {
      if (request.stage === 'plan') return plan([]);
      if (request.stage === 'summary') return { status: 'ok', data: { summary: 's', files: [] } };
      if (request.stage === 'find') return { status: 'ok', data: [finding] };
      if (request.stage === 'validate') return { status: 'infra_error', error: 'timeout' };
      if (request.stage === 'adjudicate') {
        adjudications += 1;
        return { status: 'ok', data: { decision: 'accept' } };
      }
      throw new Error(`unexpected ${request.stage}`);
    }),
  });
  assert.deepEqual(result.findings, []);
  assert.equal(adjudications, 0);
  assert.ok(result.failures.some((failure) => /could not collect 5/.test(failure.error)));
});
