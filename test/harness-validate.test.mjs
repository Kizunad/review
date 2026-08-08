import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  RUNNER_REVIEW_VERSION,
  runCli,
  synthesizeInfrastructureFailure,
  validateRunnerReview,
} from '../harness/validate-review.mjs';
import { EVIDENCE_VERSION } from '../harness/evidence.mjs';

const HEAD = 'a'.repeat(40);

function finding(overrides = {}) {
  return {
    taxonomy: 'correctness',
    path: 'src/session.rs',
    line: 42,
    title: 'reconnect drops the queued headless client frames',
    evidence: {
      mode: 'test',
      commands: ['harness/scrub-env.sh cargo test session_reconnect'],
      artifacts: ['a1/session_reconnect.rs', 'a1/run.log'],
      exitCodes: [101],
      assignmentId: 'a1',
    },
    rootCause: 'the reconnect path clears the queue before flushing it',
    level: 'major',
    fingerprint: 'f'.repeat(64),
    ...overrides,
  };
}

function review(overrides = {}) {
  return {
    version: RUNNER_REVIEW_VERSION,
    decision: 'request_changes',
    headOid: HEAD,
    findings: [finding()],
    failures: [],
    degradations: [],
    resumedFrom: null,
    ...overrides,
  };
}

test('accepts the three v1-compatible decisions with their invariants', () => {
  assert.deepEqual(validateRunnerReview(review(), { headOid: HEAD }).errors, []);
  assert.equal(validateRunnerReview(review({ decision: 'approve', findings: [] }), { headOid: HEAD }).ok, true);
  assert.equal(validateRunnerReview(review({ decision: 'approve', findings: [finding({ level: 'minor' })] }), { headOid: HEAD }).ok, true);
  assert.equal(validateRunnerReview(review({
    decision: 'infrastructure_failure',
    findings: [],
    failures: [{ stage: 'trunk', status: 'infra_error', error: 'wall clock exceeded' }],
  }), { headOid: HEAD }).ok, true);
});

test('enforces v1 decision invariants verbatim', () => {
  // infra 不许带 finding,必须带 failure。
  assert.equal(validateRunnerReview(review({ decision: 'infrastructure_failure', failures: [{ stage: 's', status: 'infra_error', error: 'x' }] })).ok, false);
  assert.equal(validateRunnerReview(review({ decision: 'infrastructure_failure', findings: [], failures: [] })).ok, false);
  // approve 不许带非 minor finding 或 failure。
  assert.equal(validateRunnerReview(review({ decision: 'approve' })).ok, false);
  assert.equal(validateRunnerReview(review({ decision: 'approve', findings: [], failures: [{ stage: 's', status: 'infra_error', error: 'x' }] })).ok, false);
  // request_changes 必须至少一条 finding、零 failure。
  assert.equal(validateRunnerReview(review({ findings: [] })).ok, false);
  assert.equal(validateRunnerReview(review({ failures: [{ stage: 's', status: 'infra_error', error: 'x' }] })).ok, false);
});

test('rejects headOid drift against the authoritative PR head', () => {
  const { ok, errors } = validateRunnerReview(review(), { headOid: 'b'.repeat(40) });
  assert.equal(ok, false);
  assert.match(errors.join(' '), /authoritative PR head/);
  assert.equal(validateRunnerReview(review({ headOid: 'not-an-oid' })).ok, false);
});

test('rejects extra, missing, or renamed top-level fields', () => {
  assert.equal(validateRunnerReview({ ...review(), suggestions: [] }).ok, false);
  const { degradations, ...missing } = review();
  assert.equal(validateRunnerReview(missing).ok, false);
  assert.equal(validateRunnerReview(null).ok, false);
});

test('findings must carry a structured measurement evidence object', () => {
  assert.equal(validateRunnerReview(review({ findings: [finding({ evidence: 'saw it in the diff' })] })).ok, false);
  assert.equal(validateRunnerReview(review({ findings: [finding({ evidence: { mode: 'test', commands: [], artifacts: [], exitCodes: [0], assignmentId: 'a1' } })] })).ok, false);
  assert.equal(validateRunnerReview(review({ findings: [finding({ evidence: { mode: 'test', commands: ['x'], artifacts: ['/abs'], exitCodes: [0], assignmentId: 'a1' } })] })).ok, false);
});

test('cross-checks finding evidence against completed assignments when provided', () => {
  const options = { headOid: HEAD, completedAssignments: ['a1'] };
  assert.equal(validateRunnerReview(review(), options).ok, true);
  const orphan = review({ findings: [finding({ evidence: { ...finding().evidence, assignmentId: 'a9' } })] });
  const { ok, errors } = validateRunnerReview(orphan, options);
  assert.equal(ok, false);
  assert.match(errors.join(' '), /no completed evidence on disk/);
});

test('bounds degradations and resumedFrom without requiring them', () => {
  assert.equal(validateRunnerReview(review({
    degradations: [{ at: '2026-08-08T10:00:00Z', from: 'concurrency-2', to: 'concurrency-1', reason: 'relay first-byte latency' }],
    resumedFrom: 'run-17',
  }), { headOid: HEAD }).ok, true);
  assert.equal(validateRunnerReview(review({ degradations: [{ at: 'x', from: 'y', to: 'z' }] })).ok, false);
  assert.equal(validateRunnerReview(review({ degradations: {} })).ok, false);
  assert.equal(validateRunnerReview(review({ resumedFrom: 42 })).ok, false);
  assert.equal(validateRunnerReview(review({ resumedFrom: '' })).ok, false);
});

test('synthesized infrastructure failure passes its own gate', () => {
  const synthesized = synthesizeInfrastructureFailure({
    headOid: HEAD,
    stage: 'trunk',
    error: 'trunk pane died before producing review.json',
    resumedFrom: 'run-3',
  });
  assert.equal(synthesized.decision, 'infrastructure_failure');
  assert.equal(synthesized.resumedFrom, 'run-3');
  assert.deepEqual(validateRunnerReview(synthesized, { headOid: HEAD }).errors, []);
  // 空错误文本也必须合成出合同内的 failure。
  const fallback = synthesizeInfrastructureFailure({ headOid: HEAD, error: '' });
  assert.equal(validateRunnerReview(fallback, { headOid: HEAD }).ok, true);
  assert.throws(() => synthesizeInfrastructureFailure({ headOid: 'nope', error: 'x' }), /invalid/);
});

test('validate CLI scans evidence and fails closed on orphan citations', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'validate-cli-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'evidence'), { recursive: true });
  await writeFile(path.join(root, 'evidence', 'a1.json'), JSON.stringify({
    version: EVIDENCE_VERSION,
    assignmentId: 'a1',
    mode: 'test',
    worker: 'W2',
    headOid: HEAD,
    commands: ['harness/scrub-env.sh npm test'],
    artifacts: [],
    exitCodes: [1],
    verdict: 'fail',
    notes: '',
    binaryProvenance: null,
  }));
  const reviewFile = path.join(root, 'review.json');
  await writeFile(reviewFile, JSON.stringify(review()));
  const environment = { HEAD_OID: HEAD, HARNESS_DIR: root };
  assert.deepEqual(await runCli(['validate', reviewFile], environment), { ok: true, errors: [], decision: 'request_changes' });

  await rm(path.join(root, 'evidence', 'a1.json'));
  const { ok, errors } = await runCli(['validate', reviewFile], environment);
  assert.equal(ok, false);
  assert.match(errors.join(' '), /no completed evidence/);

  const malformed = await runCli(['validate', path.join(root, 'absent.json')], environment);
  assert.equal(malformed.ok, false);
});
