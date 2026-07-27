import test from 'node:test';
import assert from 'node:assert/strict';
import { runReview } from '../src/orchestrator.mjs';

const finding = {
  version: 'v1', taxonomy: 'security', path: 'src/a.mjs', line: 4, title: 'Missing guard', evidence: 'route is public', rootCause: 'no authorization', severity: 'major',
};

function runnerFor(handler) {
  return { run: async (request) => handler(request) };
}

function plan(assignments = [{ id: 'a', shardIndexes: [0] }]) {
  return { status: 'ok', data: { assignments }, transcript: 'never pass this' };
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

test('preserves bounded runner diagnostics on stage infrastructure failure', async () => {
  const result = await runReview({
    diff: 'd',
    taxonomy: ['security'],
    runner: runnerFor((request) => {
      if (request.stage === 'plan') {
        return {
          status: 'infra_error',
          error: 'timeout after 60000ms',
          diagnostic: '{"events":[{"subtype":"api_retry","errorStatus":524}]}',
        };
      }
      throw new Error(`unexpected ${request.stage}`);
    }),
  });
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.failures, [{
    stage: 'plan',
    status: 'infra_error',
    error: 'timeout after 60000ms',
    diagnostic: '{"events":[{"subtype":"api_retry","errorStatus":524}]}',
  }]);
});
test('keeps all Sol output out of Terra input and accepts four confirmations', async () => {
  const requests = [];
  const result = await runReview({
    diff: 'diff --git a/a.mjs b/a.mjs\n', taxonomy: ['security'],
    runner: runnerFor((request) => {
      requests.push(request);
      if (request.stage === 'plan') return plan();
      if (request.stage === 'summary') return { status: 'ok', data: { summary: 'one file', files: ['a.mjs'] } };
      if (request.stage === 'find') return { status: 'ok', data: [finding] };
      if (request.stage === 'validate') {
        const verdict = request.validator === 4 ? 'reject' : 'confirm';
        return { status: 'ok', data: { verdict, reachable: verdict === 'confirm' } };
      }
      throw new Error(`unexpected ${request.stage}`);
    }),
  });
  assert.equal(result.findings.length, 1);
  const finder = requests.find((request) => request.stage === 'find');
  assert.equal('plan' in finder, false);
  assert.equal('transcript' in finder, false);
  assert.deepEqual(finder.summaries, [{ assignment: 'a', data: { summary: 'one file', files: ['a.mjs'] } }]);
  assert.equal(requests.filter((request) => request.stage === 'validate').length, 5);
  assert.ok(requests.filter((request) => request.stage === 'validate').every((request) => request.relatedDiff.includes('diff --git a/a.mjs b/a.mjs')));
});


test('fails closed with a candidate-specific taxonomy error before validation', async () => {
  const requests = [];
  const missingTaxonomy = { ...finding };
  delete missingTaxonomy.taxonomy;
  const result = await runReview({
    diff: 'diff --git a/a.mjs b/a.mjs\n',
    taxonomy: ['security'],
    runner: runnerFor((request) => {
      requests.push(request);
      if (request.stage === 'plan') return plan();
      if (request.stage === 'summary') return { status: 'ok', data: { summary: 'one file', files: ['a.mjs'] } };
      if (request.stage === 'find') return { status: 'ok', data: [finding, missingTaxonomy] };
      throw new Error(`unexpected ${request.stage}`);
    }),
  });

  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.failures.map(({ stage, status }) => ({ stage, status })), [{
    stage: 'find:security',
    status: 'schema_error',
  }]);
  assert.match(result.failures[0].error, /batch-0: candidate-1: finding is missing taxonomy/);
  assert.equal(requests.some((request) => request.stage === 'validate' || request.stage === 'adjudicate'), false);
  assert.equal(result.failures.some((failure) => failure.stage === 'orchestrator'), false);
});

test('rejects a finder candidate assigned to another taxonomy dimension', async () => {
  const requests = [];
  const result = await runReview({
    diff: 'diff --git a/a.mjs b/a.mjs\n',
    taxonomy: ['security'],
    runner: runnerFor((request) => {
      requests.push(request);
      if (request.stage === 'plan') return plan();
      if (request.stage === 'summary') return { status: 'ok', data: { summary: 'one file', files: ['a.mjs'] } };
      if (request.stage === 'find') return { status: 'ok', data: [{ ...finding, taxonomy: 'correctness' }] };
      throw new Error(`unexpected ${request.stage}`);
    }),
  });

  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.failures.map(({ stage, status }) => ({ stage, status })), [{
    stage: 'find:security',
    status: 'schema_error',
  }]);
  assert.match(result.failures[0].error, /candidate taxonomy must exactly equal assigned dimension "security"/);
  assert.equal(requests.some((request) => request.stage === 'validate' || request.stage === 'adjudicate'), false);
});

test('collects deterministic finder contract failures after all queued work completes', async () => {
  const dimensions = ['slow', 'fast', 'queued'];
  const diff = `diff --git a/large.js b/large.js\n${'x'.repeat(41)}`;
  const calls = [];
  const requests = [];
  let releaseSlow;
  const slowGate = new Promise((resolve) => { releaseSlow = resolve; });
  const review = runReview({
    diff,
    taxonomy: dimensions,
    maxShardChars: 10,
    maxFinderChars: 15,
    runner: runnerFor(async (request) => {
      requests.push(request);
      if (request.stage === 'plan') return plan([{ id: 'first', shardIndexes: [0] }]);
      if (request.stage === 'summary') return { status: 'ok', data: { summary: 'bounded', files: request.assignment.paths } };
      if (request.stage === 'find') {
        const batchIndex = calls.filter((call) => call.taxonomy === request.taxonomy).length;
        calls.push({ taxonomy: request.taxonomy, diff: request.diff, paths: request.paths, batchIndex });
        if (request.taxonomy === 'slow' && batchIndex === 0) await slowGate;
        if ((request.taxonomy === 'slow' && batchIndex === 1)
          || (request.taxonomy === 'queued' && batchIndex === 0)) {
          const missingTaxonomy = { ...finding };
          delete missingTaxonomy.taxonomy;
          return { status: 'ok', data: [{ ...missingTaxonomy, version: 'v1' }] };
        }
        return { status: 'ok', data: [] };
      }
      throw new Error(`unexpected ${request.stage}`);
    }),
  });

  await waitFor(
    () => calls.some((call) => call.taxonomy === 'queued'),
    'fast lane should finish and admit queued taxonomy while slow lane is blocked',
  );
  releaseSlow();
  const result = await review;

  for (const dimension of dimensions) {
    const scoped = calls.filter((call) => call.taxonomy === dimension);
    assert.ok(scoped.length > 1);
    assert.equal(scoped.map((call) => call.diff).join(''), diff);
    assert.ok(scoped.every((call) => call.paths[0] === 'large.js'));
  }
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.failures.map(({ stage, status }) => ({ stage, status })), [
    { stage: 'find:slow', status: 'schema_error' },
    { stage: 'find:queued', status: 'schema_error' },
  ]);
  assert.match(result.failures[0].error, /batch-1: candidate-0: finding is missing taxonomy/);
  assert.match(result.failures[1].error, /batch-0: candidate-0: finding is missing taxonomy/);
  assert.equal(requests.some((request) => request.stage === 'validate' || request.stage === 'adjudicate'), false);
});


test('rejects finder batches above the candidate array contract', async () => {
  const tooMany = Array.from({ length: 129 }, (_, index) => ({
    ...finding,
    line: index + 1,
    title: `candidate-${index}`,
    rootCause: `cause-${index}`,
  }));
  const result = await runReview({
    diff: 'diff',
    taxonomy: ['security'],
    runner: runnerFor((request) => {
      if (request.stage === 'plan') return plan();
      if (request.stage === 'summary') return { status: 'ok', data: { summary: 'bounded', files: request.assignment.paths } };
      if (request.stage === 'find') return { status: 'ok', data: tooMany };
      throw new Error(`unexpected ${request.stage}`);
    }),
  });

  assert.deepEqual(result.findings, []);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].stage, 'find:security');
  assert.equal(result.failures[0].status, 'schema_error');
  assert.match(result.failures[0].error, /at most 128 candidates/);
});
test('aggregates unbounded malformed finder candidates by taxonomy and status', async () => {
  const dimensions = Array.from({ length: 8 }, (_, index) => `dimension-${index}`);
  const malformed = { ...finding };
  delete malformed.rootCause;
  let finderCalls = 0;
  const result = await runReview({
    diff: `diff --git a/large.js b/large.js\n${'x'.repeat(41)}`,
    taxonomy: dimensions,
    maxShardChars: 10,
    maxFinderChars: 15,
    runner: runnerFor((request) => {
      if (request.stage === 'plan') return plan([{ id: 'first', shardIndexes: [0] }]);
      if (request.stage === 'summary') return { status: 'ok', data: { summary: 'bounded', files: request.assignment.paths } };
      if (request.stage === 'find') {
        finderCalls += 1;
        return request.taxonomy === 'dimension-0' && finderCalls === 1
          ? { status: 'infra_error', error: 'provider unavailable', diagnostic: 'error_max_structured_output_retries' }
          : { status: 'ok', data: Array.from({ length: 128 }, () => ({ ...malformed, taxonomy: request.taxonomy })) };
      }
      throw new Error(`unexpected ${request.stage}`);
    }),
  });

  assert.ok(finderCalls > dimensions.length);
  assert.deepEqual(result.findings, []);
  assert.ok(result.failures.length <= dimensions.length * 2);
  assert.deepEqual(result.failures.slice(0, 2).map(({ stage, status }) => ({ stage, status })), [
    { stage: 'find:dimension-0', status: 'infra_error' },
    { stage: 'find:dimension-0', status: 'schema_error' },
  ]);
  assert.match(result.failures[0].diagnostic, /error_max_structured_output_retries/);
  assert.ok(result.failures.filter((failure) => failure.status === 'schema_error').every((failure) => /occurrence\(s\)/.test(failure.error)));
  assert.ok(result.failures.filter((failure) => failure.status === 'schema_error').every((failure) => /omitted/.test(failure.error)));
});

test('starts one independent Terra finder for every taxonomy dimension', async () => {
  const dimensions = ['correctness', 'security', 'performance'];
  const finders = [];
  const result = await runReview({
    diff: 'diff --git a/a.mjs b/a.mjs\n', taxonomy: dimensions,
    runner: runnerFor((request) => {
      if (request.stage === 'plan') return plan();
      if (request.stage === 'summary') return { status: 'ok', data: { summary: 'one file', files: ['a.mjs'] } };
      if (request.stage === 'find') {
        finders.push(request);
        return { status: 'ok', data: [] };
      }
      throw new Error(`unexpected ${request.stage}`);
    }),
  });
  assert.deepEqual(result.findings, []);
  assert.deepEqual(finders.map((request) => request.taxonomy).sort(), dimensions.sort());
  assert.ok(finders.every((request) => request.model === 'terra'));
  assert.ok(finders.every((request) => !('plan' in request) && !('transcript' in request)));
});

test('bounds Terra finder concurrency at two without dropping queued taxonomy work', async () => {
  const dimensions = Array.from({ length: 8 }, (_, index) => `dimension-${index}`);
  const started = [];
  const releases = [];
  let active = 0;
  let peak = 0;
  const review = runReview({
    diff: 'diff --git a/a.mjs b/a.mjs\n', taxonomy: dimensions,
    runner: runnerFor(async (request) => {
      if (request.stage === 'plan') return plan();
      if (request.stage === 'summary') return { status: 'ok', data: { summary: 'one file', files: ['a.mjs'] } };
      if (request.stage === 'find') {
        started.push(request.taxonomy);
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => releases.push(resolve));
        active -= 1;
        return request.taxonomy === 'dimension-0'
          ? { status: 'infra_error', error: 'provider unavailable' }
          : { status: 'ok', data: [] };
      }
      throw new Error(`unexpected ${request.stage}`);
    }),
  });

  for (let released = 0; released < dimensions.length; released += 2) {
    const expectedStarted = Math.min(released + 2, dimensions.length);
    await waitFor(
      () => started.length === expectedStarted,
      `expected ${expectedStarted} queued finders to start`,
    );
    assert.ok(active <= 2);
    releases.splice(0).forEach((resolve) => resolve());
  }

  const result = await review;
  assert.equal(peak, 2);
  assert.deepEqual(started, dimensions);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.failures.map(({ stage, status }) => ({ stage, status })), [{
    stage: 'find:dimension-0',
    status: 'infra_error',
  }]);
  assert.match(result.failures[0].error, /batch-0: provider unavailable/);
});

test('preserves taxonomy and batch order when bounded finder lanes finish out of order', async () => {
  const dimensions = ['slow', 'fast', 'queued'];
  const diff = `diff --git a/large.js b/large.js\n${'x'.repeat(41)}`;
  const calls = [];
  let releaseSlow;
  const slowGate = new Promise((resolve) => { releaseSlow = resolve; });
  const review = runReview({
    diff,
    taxonomy: dimensions,
    maxShardChars: 10,
    maxFinderChars: 15,
    runner: runnerFor(async (request) => {
      if (request.stage === 'plan') return plan([{ id: 'first', shardIndexes: [0] }]);
      if (request.stage === 'summary') return { status: 'ok', data: { summary: 'bounded', files: request.assignment.paths } };
      if (request.stage === 'find') {
        calls.push({ taxonomy: request.taxonomy, diff: request.diff, paths: request.paths });
        if (request.taxonomy === 'slow' && calls.filter((call) => call.taxonomy === 'slow').length === 1) {
          await slowGate;
        }
        if (request.taxonomy === 'slow' || request.taxonomy === 'queued') {
          return { status: 'infra_error', error: `${request.taxonomy} failure` };
        }
        return { status: 'ok', data: [] };
      }
      throw new Error(`unexpected ${request.stage}`);
    }),
  });

  await waitFor(
    () => calls.some((call) => call.taxonomy === 'queued'),
    'fast lane should finish and admit queued taxonomy while slow lane is blocked',
  );
  releaseSlow();
  const result = await review;

  for (const dimension of dimensions) {
    const scoped = calls.filter((call) => call.taxonomy === dimension);
    assert.ok(scoped.length > 1);
    assert.equal(scoped.map((call) => call.diff).join(''), diff);
    assert.ok(scoped.every((call) => call.paths[0] === 'large.js'));
  }
  assert.deepEqual(
    result.failures.map((failure) => failure.stage),
    ['find:slow', 'find:queued'],
  );
  assert.ok(result.failures.every((failure) => /occurrence\(s\)/.test(failure.error)));
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
  assert.ok(summaries.every((request) => request.diff.length <= 30));
});

test('shards every finder dimension without dropping diff content or continuation paths', async () => {
  const finders = [];
  const summaries = [];
  const diff = `diff --git a/large.js b/large.js\n${'x'.repeat(41)}`;
  const shardCount = Math.ceil(diff.length / 10);
  await runReview({
    diff,
    taxonomy: ['security', 'performance'],
    maxShardChars: 10,
    maxFinderChars: 15,
    runner: runnerFor((request) => {
      if (request.stage === 'plan') return plan([{ id: 'first', shardIndexes: [0] }]);
      if (request.stage === 'summary') {
        summaries.push(request);
        return { status: 'ok', data: { summary: 'bounded', files: request.assignment.paths } };
      }
      if (request.stage === 'find') {
        finders.push(request);
        return { status: 'ok', data: [] };
      }
      throw new Error(`unexpected ${request.stage}`);
    }),
  });
  assert.equal(summaries.length, shardCount);
  assert.ok(summaries.every((request) => request.diff.length <= 10));
  assert.ok(summaries.every((request) => request.assignment.paths[0] === 'large.js'));
  for (const dimension of ['security', 'performance']) {
    const scoped = finders.filter((request) => request.taxonomy === dimension);
    assert.ok(scoped.length > 1);
    assert.ok(scoped.every((request) => request.diff.length <= 15));
    assert.ok(scoped.every((request) => request.paths[0] === 'large.js'));
    assert.equal(scoped.map((request) => request.diff).join(''), diff);
  }
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
      if (request.stage === 'validate') {
        const verdict = request.validator < 2 ? 'confirm' : 'reject';
        return { status: 'ok', data: { verdict, reachable: verdict === 'confirm' } };
      }
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
        const verdict = attempts === 7 ? 'reject' : 'confirm';
        return { status: 'ok', data: { verdict, reachable: verdict === 'confirm' } };
      }
      throw new Error(`unexpected ${request.stage}`);
    }),
  });
  assert.equal(attempts, 7);
  assert.equal(result.findings.length, 1);
  assert.equal(result.failures.filter((failure) => failure.status === 'infra_error').length, 2);
});

test('replaces unreachable confirmation votes instead of counting them', async () => {
  let attempts = 0;
  const result = await runReview({
    diff: 'd', taxonomy: ['security'],
    runner: runnerFor((request) => {
      if (request.stage === 'plan') return plan([]);
      if (request.stage === 'summary') return { status: 'ok', data: { summary: 's', files: [] } };
      if (request.stage === 'find') return { status: 'ok', data: [finding] };
      if (request.stage === 'validate') {
        attempts += 1;
        if (attempts <= 2) return { status: 'ok', data: { verdict: 'confirm', reachable: false } };
        const verdict = attempts === 7 ? 'reject' : 'confirm';
        return { status: 'ok', data: { verdict, reachable: verdict === 'confirm' } };
      }
      throw new Error(`unexpected ${request.stage}`);
    }),
  });
  assert.equal(attempts, 7);
  assert.equal(result.findings.length, 1);
  assert.equal(result.failures.filter((failure) => failure.status === 'schema_error').length, 2);
  assert.ok(result.failures.every((failure) => !/could not collect 5/.test(failure.error)));
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
