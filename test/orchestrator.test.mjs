import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LITE_MODEL,
  DEFAULT_REVIEWER_MODEL,
  LITE_MODEL,
  REVIEWER_MODEL,
  resolveLiteModel,
  resolveReviewerModel,
  runReview,
} from '../src/orchestrator.mjs';
import { finalDecision, partitionValidatedFindings } from '../src/review-entry.mjs';

const finding = {
  version: 'v2', taxonomy: 'security', path: 'src/a.mjs', line: 4, title: 'Missing guard', evidence: 'route is public', rootCause: 'no authorization', level: 'major',
};

function runnerFor(handler) {
  return { run: async (request) => handler(request) };
}

function plan(assignments = [{ id: 'a', shardIndexes: [0] }]) {
  return { status: 'ok', data: { assignments }, transcript: 'never pass this' };
}

function consolidate(request, clusters = request.candidates.map((candidate) => ({
  representativeFingerprint: candidate.fingerprint,
  memberFingerprints: [candidate.fingerprint],
}))) {
  return { status: 'ok', data: { version: 'v2', clusters } };
}

function vote(request, verdict, level = verdict === 'confirm' ? 'major' : 'suggestion', overrides = {}) {
  return {
    status: 'ok',
    data: {
      version: 'v2',
      candidateFingerprint: request.candidate.fingerprint,
      verdict,
      reachable: verdict === 'confirm',
      level,
      evidence: 'independent repository evidence',
      reason: 'independent validator rationale',
      ...overrides,
    },
  };
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
      if (request.stage === 'consolidate') return consolidate(request);
      if (request.stage === 'validate') {
        const verdict = request.validator === 4 ? 'reject' : 'confirm';
        return vote(request, verdict);
      }
      throw new Error(`unexpected ${request.stage}`);
    }),
  });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].level, 'major');
  assert.equal(result.findings[0].voteSupport, 4);
  assert.equal(result.findings[0].provenance.length, 1);
  const finder = requests.find((request) => request.stage === 'find');
  assert.equal('plan' in finder, false);
  assert.equal('transcript' in finder, false);
  assert.deepEqual(finder.summaries, [{ assignment: 'a', data: { summary: 'one file', files: ['a.mjs'] } }]);
  assert.equal(requests.filter((request) => request.stage === 'validate').length, 5);
  assert.ok(requests.filter((request) => request.stage === 'validate')
    .every((request) => request.model === REVIEWER_MODEL));
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
          return { status: 'ok', data: [{ ...missingTaxonomy, version: 'v2' }] };
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
  assert.equal(REVIEWER_MODEL, DEFAULT_REVIEWER_MODEL);
  assert.ok(finders.every((request) => request.model === REVIEWER_MODEL));
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
  assert.equal(summaries[0].model, LITE_MODEL);
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

test('exact-deduplicates cross-taxonomy duplicates before one Sol cluster and one five-vote gate', async () => {
  const dimensions = ['security', 'correctness', 'testing', 'maintainability'];
  const requests = [];
  const result = await runReview({
    diff: 'diff --git a/src/a.mjs b/src/a.mjs\n',
    taxonomy: dimensions,
    runner: runnerFor((request) => {
      requests.push(request);
      if (request.stage === 'plan') return plan();
      if (request.stage === 'summary') return { status: 'ok', data: { summary: 'one file', files: ['src/a.mjs'] } };
      if (request.stage === 'find') return { status: 'ok', data: [{ ...finding, taxonomy: request.taxonomy }] };
      if (request.stage === 'consolidate') return consolidate(request);
      if (request.stage === 'validate') return vote(request, request.validator === 4 ? 'reject' : 'confirm');
      throw new Error(`unexpected ${request.stage}`);
    }),
  });

  const consolidation = requests.filter((request) => request.stage === 'consolidate');
  assert.equal(consolidation.length, 1);
  assert.equal(consolidation[0].candidates.length, 1);
  assert.deepEqual(
    consolidation[0].candidates[0].provenance.map((entry) => entry.taxonomy),
    dimensions,
  );
  assert.equal(requests.filter((request) => request.stage === 'validate').length, 5);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].provenance.length, 4);
});

test('Sol consolidation merges same-path wording variants but preserves distinct root causes', async () => {
  const variants = [
    { ...finding, line: 4, rootCause: 'missing authorization', title: 'Missing route guard' },
    { ...finding, line: 5, rootCause: 'unguarded public mutation', title: 'Public mutation is unguarded' },
    { ...finding, line: 30, rootCause: 'non atomic persistence', title: 'Persistence can tear' },
  ];
  let validations = 0;
  const result = await runReview({
    diff: 'diff --git a/src/a.mjs b/src/a.mjs\n',
    taxonomy: ['security'],
    runner: runnerFor((request) => {
      if (request.stage === 'plan') return plan();
      if (request.stage === 'summary') return { status: 'ok', data: { summary: 'one file', files: ['src/a.mjs'] } };
      if (request.stage === 'find') return { status: 'ok', data: variants };
      if (request.stage === 'consolidate') {
        const adjacent = request.candidates.filter((candidate) => candidate.line < 30);
        const distinct = request.candidates.find((candidate) => candidate.line === 30);
        return consolidate(request, [
          {
            representativeFingerprint: adjacent[0].fingerprint,
            memberFingerprints: adjacent.map((candidate) => candidate.fingerprint),
          },
          {
            representativeFingerprint: distinct.fingerprint,
            memberFingerprints: [distinct.fingerprint],
          },
        ]);
      }
      if (request.stage === 'validate') {
        validations += 1;
        return vote(request, request.validator === 4 ? 'reject' : 'confirm');
      }
      throw new Error(`unexpected ${request.stage}`);
    }),
  });

  assert.equal(result.findings.length, 2);
  assert.equal(validations, 10);
  assert.equal(result.findings.find((candidate) => candidate.memberFingerprints.length === 2).provenance.length, 2);
  assert.equal(result.findings.find((candidate) => candidate.memberFingerprints.length === 1).provenance.length, 1);
});

test('splits a mixed-root cluster and independently gates every exact candidate', async () => {
  const variants = [
    {
      ...finding,
      line: 10,
      title: 'Logging text is unclear',
      evidence: 'The log line uses an ambiguous label.',
      rootCause: 'logging text unclear',
      level: 'suggestion',
    },
    {
      ...finding,
      line: 40,
      title: 'Delete route lacks authorization',
      evidence: 'An untrusted caller reaches the destructive mutation.',
      rootCause: 'delete lacks authorization',
      level: 'major',
    },
  ];
  const validated = [];
  const result = await runReview({
    diff: 'diff --git a/src/a.mjs b/src/a.mjs\n',
    taxonomy: ['security'],
    runner: runnerFor((request) => {
      if (request.stage === 'plan') return plan();
      if (request.stage === 'summary') return { status: 'ok', data: { summary: 'one file', files: ['src/a.mjs'] } };
      if (request.stage === 'find') return { status: 'ok', data: variants };
      if (request.stage === 'consolidate') {
        return consolidate(request, [{
          representativeFingerprint: request.candidates.find((candidate) => candidate.line === 10).fingerprint,
          memberFingerprints: request.candidates.map((candidate) => candidate.fingerprint),
        }]);
      }
      if (request.stage === 'validate') {
        validated.push(request.candidate.validationCandidates.map((candidate) => candidate.rootCause));
        if (request.candidate.memberFingerprints.length > 1) return vote(request, 'split');
        return vote(request, 'confirm', request.candidate.line === 40 ? 'major' : 'suggestion');
      }
      throw new Error(`unexpected ${request.stage}`);
    }),
  });

  assert.equal(validated.length, 15);
  assert.ok(validated.slice(0, 5).every((rootCauses) => rootCauses.includes('logging text unclear')));
  assert.ok(validated.slice(0, 5).every((rootCauses) => rootCauses.includes('delete lacks authorization')));
  assert.deepEqual(validated.slice(5).flat().sort(), Array(5).fill('delete lacks authorization')
    .concat(Array(5).fill('logging text unclear')).sort());
  assert.equal(result.findings.length, 2);
  assert.equal(result.findings.find((candidate) => candidate.line === 40).level, 'major');
  assert.equal(result.findings.find((candidate) => candidate.line === 10).level, 'suggestion');
  const publicFindings = partitionValidatedFindings(result.findings).findings;
  assert.equal(finalDecision({ findings: publicFindings, failures: result.failures }, {
    minorFindingsRequestChanges: false,
  }), 'request_changes');
  assert.deepEqual(result.failures, []);
});

test('splitting preserves all provenance attached to each exact candidate', async () => {
  const dimensions = ['security', 'correctness', 'testing'];
  const result = await runReview({
    diff: 'diff --git a/src/a.mjs b/src/a.mjs\n',
    taxonomy: dimensions,
    runner: runnerFor((request) => {
      if (request.stage === 'plan') return plan();
      if (request.stage === 'summary') return { status: 'ok', data: { summary: 'one file', files: ['src/a.mjs'] } };
      if (request.stage === 'find') {
        return {
          status: 'ok',
          data: [
            { ...finding, taxonomy: request.taxonomy, line: 10, rootCause: 'missing authorization' },
            { ...finding, taxonomy: request.taxonomy, line: 40, rootCause: 'non atomic persistence' },
          ],
        };
      }
      if (request.stage === 'consolidate') {
        return consolidate(request, [{
          representativeFingerprint: request.candidates[0].fingerprint,
          memberFingerprints: request.candidates.map((candidate) => candidate.fingerprint),
        }]);
      }
      if (request.stage === 'validate') {
        return vote(request, request.candidate.memberFingerprints.length > 1 ? 'split' : 'confirm');
      }
      throw new Error(`unexpected ${request.stage}`);
    }),
  });

  assert.equal(result.findings.length, 2);
  assert.ok(result.findings.every((candidate) => candidate.provenance.length === dimensions.length));
  assert.deepEqual(result.failures, []);
});
test('splits a cluster exactly once and never duplicates the original candidate set', async () => {
  const variants = Array.from({ length: 8 }, (_, index) => ({
    ...finding,
    line: index + 1,
    rootCause: `independent cause ${index}`,
  }));
  const singletonGates = new Map();
  const result = await runReview({
    diff: 'd', taxonomy: ['security'],
    runner: runnerFor((request) => {
      if (request.stage === 'plan') return plan([]);
      if (request.stage === 'summary') return { status: 'ok', data: { summary: 's', files: [] } };
      if (request.stage === 'find') return { status: 'ok', data: variants };
      if (request.stage === 'consolidate') {
        return consolidate(request, [{
          representativeFingerprint: request.candidates[0].fingerprint,
          memberFingerprints: request.candidates.map((candidate) => candidate.fingerprint),
        }]);
      }
      if (request.stage === 'validate') {
        if (request.candidate.memberFingerprints.length > 1) return vote(request, 'split');
        singletonGates.set(
          request.candidate.fingerprint,
          (singletonGates.get(request.candidate.fingerprint) ?? 0) + 1,
        );
        return vote(request, 'confirm', 'minor');
      }
      throw new Error(`unexpected ${request.stage}`);
    }),
  });

  assert.equal(singletonGates.size, variants.length);
  assert.ok([...singletonGates.values()].every((count) => count === 5));
  assert.equal(result.findings.length, variants.length);
  assert.deepEqual(result.failures, []);
});

test('does not fan out a coherent rejected cluster', async () => {
  const variants = [
    { ...finding, line: 10, rootCause: 'missing authorization' },
    { ...finding, line: 11, rootCause: 'unguarded public mutation' },
  ];
  let validations = 0;
  const result = await runReview({
    diff: 'diff --git a/src/a.mjs b/src/a.mjs\n',
    taxonomy: ['security'],
    runner: runnerFor((request) => {
      if (request.stage === 'plan') return plan();
      if (request.stage === 'summary') return { status: 'ok', data: { summary: 'one file', files: ['src/a.mjs'] } };
      if (request.stage === 'find') return { status: 'ok', data: variants };
      if (request.stage === 'consolidate') {
        return consolidate(request, [{
          representativeFingerprint: request.candidates[0].fingerprint,
          memberFingerprints: request.candidates.map((candidate) => candidate.fingerprint),
        }]);
      }
      if (request.stage === 'validate') {
        validations += 1;
        return vote(request, 'reject');
      }
      throw new Error(`unexpected ${request.stage}`);
    }),
  });

  assert.equal(validations, 5);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.failures, []);
});

test('fails closed on unresolved structural votes and never binary-adjudicates them', async () => {
  let validations = 0;
  let adjudications = 0;
  const result = await runReview({
    diff: 'd', taxonomy: ['security'],
    runner: runnerFor((request) => {
      if (request.stage === 'plan') return plan([]);
      if (request.stage === 'summary') return { status: 'ok', data: { summary: 's', files: [] } };
      if (request.stage === 'find') return { status: 'ok', data: [finding, { ...finding, line: 5, rootCause: 'second cause' }] };
      if (request.stage === 'consolidate') {
        return consolidate(request, [{
          representativeFingerprint: request.candidates[0].fingerprint,
          memberFingerprints: request.candidates.map((candidate) => candidate.fingerprint),
        }]);
      }
      if (request.stage === 'validate') {
        validations += 1;
        return vote(request, request.validator < 3 ? 'split' : 'reject');
      }
      if (request.stage === 'adjudicate') {
        adjudications += 1;
        return { status: 'ok', data: {} };
      }
      throw new Error(`unexpected ${request.stage}`);
    }),
  });

  assert.equal(validations, 15);
  assert.equal(adjudications, 0);
  assert.deepEqual(result.findings, []);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].error, /could not resolve whether/);
});

test('remembers earlier structural votes and never binary-adjudicates the cluster', async () => {
  let validations = 0;
  let adjudications = 0;
  const result = await runReview({
    diff: 'd', taxonomy: ['security'],
    runner: runnerFor((request) => {
      if (request.stage === 'plan') return plan([]);
      if (request.stage === 'summary') return { status: 'ok', data: { summary: 's', files: [] } };
      if (request.stage === 'find') return { status: 'ok', data: [finding, { ...finding, line: 5, rootCause: 'second cause' }] };
      if (request.stage === 'consolidate') {
        return consolidate(request, [{
          representativeFingerprint: request.candidates[0].fingerprint,
          memberFingerprints: request.candidates.map((candidate) => candidate.fingerprint),
        }]);
      }
      if (request.stage === 'validate') {
        validations += 1;
        if (request.round === 1) return vote(request, request.validator < 3 ? 'split' : 'reject');
        return vote(request, request.validator < 2 ? 'confirm' : 'reject');
      }
      if (request.stage === 'adjudicate') {
        adjudications += 1;
        return { status: 'ok', data: {} };
      }
      throw new Error(`unexpected ${request.stage}`);
    }),
  });

  assert.equal(validations, 15);
  assert.equal(adjudications, 0);
  assert.deepEqual(result.findings, []);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].error, /could not resolve whether/);
});

test('retries an invalid singleton split and fails closed without looping', async () => {
  let validations = 0;
  const result = await runReview({
    diff: 'd', taxonomy: ['security'], maxValidatorAttempts: 5,
    runner: runnerFor((request) => {
      if (request.stage === 'plan') return plan([]);
      if (request.stage === 'summary') return { status: 'ok', data: { summary: 's', files: [] } };
      if (request.stage === 'find') return { status: 'ok', data: [finding] };
      if (request.stage === 'consolidate') return consolidate(request);
      if (request.stage === 'validate') {
        validations += 1;
        return vote(request, 'split');
      }
      throw new Error(`unexpected ${request.stage}`);
    }),
  });

  assert.equal(validations, 5);
  assert.deepEqual(result.findings, []);
  assert.ok(result.failures.some((failure) => /could not collect 5/.test(failure.error)));
});

test('fails closed when Sol attempts a cross-path consolidation', async () => {
  const variants = [
    { ...finding, path: 'src/a.mjs', rootCause: 'shared wording' },
    { ...finding, path: 'src/b.mjs', rootCause: 'shared wording' },
  ];
  let validations = 0;
  const result = await runReview({
    diff: 'diff',
    taxonomy: ['security'],
    runner: runnerFor((request) => {
      if (request.stage === 'plan') return plan([]);
      if (request.stage === 'summary') return { status: 'ok', data: { summary: 's', files: [] } };
      if (request.stage === 'find') return { status: 'ok', data: variants };
      if (request.stage === 'consolidate') {
        return consolidate(request, [{
          representativeFingerprint: request.candidates[0].fingerprint,
          memberFingerprints: request.candidates.map((candidate) => candidate.fingerprint),
        }]);
      }
      if (request.stage === 'validate') {
        validations += 1;
        return vote(request, 'confirm');
      }
      throw new Error(`unexpected ${request.stage}`);
    }),
  });

  assert.deepEqual(result.findings, []);
  assert.equal(validations, 0);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].stage, 'consolidate');
  assert.equal(result.failures[0].status, 'schema_error');
  assert.match(result.failures[0].error, /different paths/);
});

test('fails closed on consolidation infrastructure failure', async () => {
  const result = await runReview({
    diff: 'd', taxonomy: ['security'],
    runner: runnerFor((request) => {
      if (request.stage === 'plan') return plan([]);
      if (request.stage === 'summary') return { status: 'ok', data: { summary: 's', files: [] } };
      if (request.stage === 'find') return { status: 'ok', data: [finding] };
      if (request.stage === 'consolidate') return { status: 'infra_error', error: 'Sol unavailable' };
      throw new Error(`unexpected ${request.stage}`);
    }),
  });
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.failures, [{ stage: 'consolidate', status: 'infra_error', error: 'Sol unavailable' }]);
});

test('fails closed before Sol when exact-deduplicated candidate count exceeds the consolidation cap', async () => {
  let consolidations = 0;
  const result = await runReview({
    diff: 'd', taxonomy: ['dimension-a', 'dimension-b'],
    runner: runnerFor((request) => {
      if (request.stage === 'plan') return plan([]);
      if (request.stage === 'summary') return { status: 'ok', data: { summary: 's', files: [] } };
      if (request.stage === 'find') {
        return {
          status: 'ok',
          data: Array.from({ length: 128 }, (_, index) => ({
            ...finding,
            taxonomy: request.taxonomy,
            line: index + 1,
            title: `${request.taxonomy}-${index}`,
            rootCause: `${request.taxonomy}-cause-${index}`,
          })),
        };
      }
      if (request.stage === 'consolidate') {
        consolidations += 1;
        return consolidate(request);
      }
      throw new Error(`unexpected ${request.stage}`);
    }),
  });
  assert.equal(consolidations, 0);
  assert.deepEqual(result.findings, []);
  assert.equal(result.failures[0].stage, 'consolidate');
  assert.match(result.failures[0].error, /at most 128 candidates/);
});

test('uses validator quorum levels rather than the finder proposal', async (context) => {
  const cases = [
    { levels: ['blocker', 'blocker', 'blocker', 'blocker', 'suggestion'], expected: 'blocker' },
    { levels: ['blocker', 'major', 'major', 'major', 'suggestion'], expected: 'major' },
    { levels: ['major', 'minor', 'minor', 'minor', 'suggestion'], expected: 'minor' },
    { levels: ['major', 'suggestion', 'suggestion', 'suggestion', 'suggestion'], expected: 'suggestion' },
  ];
  for (const { levels, expected } of cases) {
    await context.test(`four-seat threshold yields ${expected}`, async () => {
      const result = await runReview({
        diff: 'd', taxonomy: ['security'],
        runner: runnerFor((request) => {
          if (request.stage === 'plan') return plan([]);
          if (request.stage === 'summary') return { status: 'ok', data: { summary: 's', files: [] } };
          if (request.stage === 'find') return { status: 'ok', data: [{ ...finding, level: 'major' }] };
          if (request.stage === 'consolidate') return consolidate(request);
          if (request.stage === 'validate') {
            return vote(request, request.validator === 4 ? 'reject' : 'confirm', request.validator === 4 ? 'suggestion' : levels[request.validator]);
          }
          throw new Error(`unexpected ${request.stage}`);
        }),
      });
      assert.equal(result.findings.length, 1);
      assert.equal(result.findings[0].level, expected);
      assert.equal(result.findings[0].voteSupport, 4);
    });
  }
});

test('replaces votes with missing levels or mismatched fingerprints before tallying', async () => {
  let attempts = 0;
  const result = await runReview({
    diff: 'd', taxonomy: ['security'],
    runner: runnerFor((request) => {
      if (request.stage === 'plan') return plan([]);
      if (request.stage === 'summary') return { status: 'ok', data: { summary: 's', files: [] } };
      if (request.stage === 'find') return { status: 'ok', data: [finding] };
      if (request.stage === 'consolidate') return consolidate(request);
      if (request.stage === 'validate') {
        attempts += 1;
        if (attempts === 1) return vote(request, 'confirm', 'major', { candidateFingerprint: 'b'.repeat(64) });
        if (attempts === 2) {
          const invalid = vote(request, 'confirm');
          delete invalid.data.level;
          return invalid;
        }
        return vote(request, attempts === 7 ? 'reject' : 'confirm');
      }
      throw new Error(`unexpected ${request.stage}`);
    }),
  });
  assert.equal(attempts, 7);
  assert.equal(result.findings.length, 1);
  assert.equal(result.failures.length, 0);
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
      if (request.stage === 'consolidate') return consolidate(request);
      if (request.stage === 'validate') {
        const verdict = request.validator < 2 ? 'confirm' : 'reject';
        return vote(request, verdict);
      }
      if (request.stage === 'adjudicate') {
        return {
          status: 'ok',
          data: {
            version: 'v2',
            candidateFingerprint: request.candidate.fingerprint,
            decision: 'accept',
            level: 'minor',
            reason: 'fresh Sol confirms a limited defect',
          },
        };
      }
      throw new Error(`unexpected ${request.stage}`);
    }),
  });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].level, 'minor');
  assert.equal(result.findings[0].voteSupport, 2);
  assert.equal(requests.filter((request) => request.stage === 'validate').length, 15);
  const adjudication = requests.find((request) => request.stage === 'adjudicate');
  assert.equal(adjudication.model, REVIEWER_MODEL);
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
      if (request.stage === 'consolidate') return consolidate(request);
      if (request.stage === 'validate') {
        attempts += 1;
        if (attempts <= 2) return { status: 'infra_error', error: 'timeout' };
        const verdict = attempts === 7 ? 'reject' : 'confirm';
        return vote(request, verdict);
      }
      throw new Error(`unexpected ${request.stage}`);
    }),
  });
  assert.equal(attempts, 7);
  assert.equal(result.findings.length, 1);
  assert.equal(result.failures.length, 0);
});

test('replaces unreachable confirmation votes instead of counting them', async () => {
  let attempts = 0;
  const result = await runReview({
    diff: 'd', taxonomy: ['security'],
    runner: runnerFor((request) => {
      if (request.stage === 'plan') return plan([]);
      if (request.stage === 'summary') return { status: 'ok', data: { summary: 's', files: [] } };
      if (request.stage === 'find') return { status: 'ok', data: [finding] };
      if (request.stage === 'consolidate') return consolidate(request);
      if (request.stage === 'validate') {
        attempts += 1;
        if (attempts <= 2) return vote(request, 'confirm', 'major', { reachable: false });
        const verdict = attempts === 7 ? 'reject' : 'confirm';
        return vote(request, verdict);
      }
      throw new Error(`unexpected ${request.stage}`);
    }),
  });
  assert.equal(attempts, 7);
  assert.equal(result.findings.length, 1);
  assert.equal(result.failures.length, 0);
});

test('fails infrastructure when five validator seats cannot be filled and never adjudicates', async () => {
  let adjudications = 0;
  const result = await runReview({
    diff: 'd', taxonomy: ['security'], maxValidatorAttempts: 5,
    runner: runnerFor((request) => {
      if (request.stage === 'plan') return plan([]);
      if (request.stage === 'summary') return { status: 'ok', data: { summary: 's', files: [] } };
      if (request.stage === 'find') return { status: 'ok', data: [finding] };
      if (request.stage === 'consolidate') return consolidate(request);
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

test('models are routing placeholders: defaults are stable names, overrides are shape-checked passthrough', () => {
  // The point of this test: the engine no longer knows which upstream tier is
  // healthy - the relay maps stable placeholder names, so routing changes need
  // zero code changes. The defaults ARE the contract with the relay mapping.
  assert.equal(DEFAULT_REVIEWER_MODEL, 'cc-review');
  assert.equal(DEFAULT_LITE_MODEL, 'cc-review-lite');
  assert.equal(resolveReviewerModel({}), DEFAULT_REVIEWER_MODEL);
  assert.equal(resolveReviewerModel({ REVIEW_MODEL: '' }), DEFAULT_REVIEWER_MODEL);
  assert.equal(resolveReviewerModel({ REVIEW_MODEL: undefined }), DEFAULT_REVIEWER_MODEL);
  assert.equal(resolveLiteModel({}), DEFAULT_LITE_MODEL);
  assert.equal(resolveLiteModel({ REVIEW_MODEL_LITE: '' }), DEFAULT_LITE_MODEL);
  // Membership is the relay's concern now: any well-formed name passes through,
  // so canaries and bisection can name a literal upstream tier directly.
  for (const model of ['sol', 'terra', 'luna', 'gpt-5.6-sol', 'claude-opus-5']) {
    assert.equal(resolveReviewerModel({ REVIEW_MODEL: model }), model);
    assert.equal(resolveLiteModel({ REVIEW_MODEL_LITE: model }), model);
  }
  // Fail closed on malformed names - a typo with a space or a flag-shaped value
  // must not silently fall back to the default, and must never parse as an arg.
  for (const bad of ['sol ', ' sol', '../sol', '--model-injection', 'a b', '"sol"']) {
    assert.throws(() => resolveReviewerModel({ REVIEW_MODEL: bad }), /REVIEW_MODEL must match/);
    assert.throws(() => resolveLiteModel({ REVIEW_MODEL_LITE: bad }), /REVIEW_MODEL_LITE must match/);
  }
});
