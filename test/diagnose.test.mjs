import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  classifyReview,
  formatReport,
  loadReview,
  parseDiagnostic,
  classifyEvents,
} from '../tools/diagnose.mjs';

const fixtures = (name) => join('test', 'fixtures', 'diagnose', name);

async function loadFixture(name) {
  const { review } = await loadReview(fixtures(name));
  return review;
}

test('classifies the old-shape summary 503 run from the diagnostic events (PR 2025)', async () => {
  const review = await loadFixture('old-503-summary');
  const classified = classifyReview(review);
  assert.equal(classified.decision, 'infrastructure_failure');
  assert.equal(classified.failures.length, 1);
  const failure = classified.failures[0];
  assert.equal(failure.stage, 'summary:bot-e2e-death-screen-scenarios');
  assert.equal(failure.status, 'infra_error');
  assert.equal(failure.terminalReason, 'api_error');
  assert.equal(failure.apiErrorStatus, 503);
  assert.equal(failure.model, 'cc-review-lite');
  assert.equal(failure.attempts, undefined, 'engine-level attempts are not in old artifacts');
  assert.equal(failure.retryable, undefined, 'retryable is not derivable for old infra_error');
  assert.equal(failure.cliRetryCount, 10);
  assert.deepEqual(failure.cliRetryStatuses, [503]);
  assert.equal(failure.classified, true);
  assert.equal(classified.clean, false);
  assert.match(classified.status, /FAILED — 1 failure\(s\), all classified/);
});

test('classifies the old-shape plan 503 run from the diagnostic events (PR 2026)', async () => {
  const review = await loadFixture('old-503-plan');
  const classified = classifyReview(review);
  const failure = classified.failures[0];
  assert.equal(failure.stage, 'plan');
  assert.equal(failure.apiErrorStatus, 503);
  assert.equal(failure.terminalReason, 'api_error');
  assert.equal(failure.model, 'cc-review');
  assert.equal(failure.cliRetryCount, 10);
  assert.equal(failure.classified, true);
});

test('classifies the old-shape 400 tool_choice failure (PR 1993 infra run)', async () => {
  const review = await loadFixture('old-400-toolchoice');
  const classified = classifyReview(review);
  const failure = classified.failures[0];
  assert.equal(failure.stage, 'summary:stale-session-token-scenario');
  assert.equal(failure.apiErrorStatus, 400);
  assert.equal(failure.terminalReason, 'api_error');
  assert.equal(failure.model, 'cc-review-lite');
  assert.equal(failure.cliRetryCount, 0, 'a confirmed 400 result carries no retry trail');
  assert.equal(failure.classified, true);
});

test('old-shape coverage gaps are unclassifiable and never read as clean (PR 1993)', async () => {
  const review = await loadFixture('old-gap-correctness');
  const classified = classifyReview(review);
  assert.equal(classified.decision, 'request_changes');
  assert.equal(classified.failures.length, 0);
  assert.equal(classified.coverageGaps.length, 1);
  const gap = classified.coverageGaps[0];
  assert.equal(gap.stage, 'find:correctness');
  assert.equal(gap.batch, 0);
  assert.ok(gap.paths.length >= 1);
  assert.equal(gap.classified, false, 'no diagnostic on a pre-contract gap');
  assert.equal(gap.terminalReason, undefined);
  assert.equal(gap.apiErrorStatus, undefined);
  assert.deepEqual(gap.evidence, ['no diagnostic recorded']);
  assert.equal(classified.clean, false, 'a gap with no diagnostic is not a healthy run');
  assert.match(classified.status, /DECIDED — 1 coverage gap\(s\), 1 unclassified/);
  const report = formatReport(review, { pullNumber: 1993, runId: 31353864338 });
  assert.match(report, /gap\s+find:correctness batch 0  UNCLASSIFIED/);
  assert.match(report, /unclassified is not clean/);
});

test('old-shape failures without any diagnostic are unclassified, schema_error stays deterministic', async () => {
  const review = await loadFixture('old-no-diag-infra');
  const classified = classifyReview(review);
  assert.equal(classified.decision, 'infrastructure_failure');
  assert.ok(classified.failures.length >= 2);
  const budget = classified.failures[0];
  assert.equal(budget.stage, 'find');
  assert.equal(budget.status, 'infra_error');
  assert.equal(budget.classified, false);
  assert.deepEqual(budget.evidence, ['no diagnostic recorded']);
  const aggregate = classified.failures[1];
  assert.equal(aggregate.status, 'schema_error');
  assert.equal(aggregate.classified, true, 'schema_error names its own cause by status');
  assert.equal(aggregate.retryable, false, 'schema_error is deterministic by contract');
  assert.equal(classified.clean, false);
  assert.match(classified.status, /FAILED — \d+ failure\(s\): \d+ classified, 1 unclassified/);
});

test('new-shape structured fields classify directly and beat the diagnostic', async () => {
  const review = await loadFixture('new-structured-cpu-gate');
  const classified = classifyReview(review);
  const failure = classified.failures[0];
  assert.equal(failure.terminalReason, 'api_error');
  assert.equal(failure.apiErrorStatus, 503);
  assert.equal(failure.apiErrorMessage, 'Service Unavailable');
  assert.equal(failure.model, 'cc-review');
  assert.equal(failure.attempts, 1);
  assert.equal(failure.retryable, true);
  assert.equal(failure.classified, true);
});

test('new-shape coverage gaps with diagnostic are classified', async () => {
  const review = await loadFixture('new-gap-with-diagnostic');
  const classified = classifyReview(review);
  assert.equal(classified.clean, false);
  const gap = classified.coverageGaps[0];
  assert.equal(gap.stage, 'find:correctness');
  assert.equal(gap.apiErrorStatus, 503);
  assert.equal(gap.terminalReason, 'api_error');
  assert.equal(gap.model, 'cc-review-lite');
  assert.equal(gap.attempts, 1);
  assert.equal(gap.retryable, true);
  assert.equal(gap.classified, true);
  assert.match(classified.status, /DECIDED — 1 coverage gap\(s\), 0 unclassified/);
});

test('an approve run with no failures and no gaps is the only thing that reads clean', async () => {
  const review = await loadFixture('approve-clean');
  const classified = classifyReview(review);
  assert.equal(classified.clean, true);
  assert.match(classified.status, /CLEAN/);
});

test('schema-exhausted new-shape failure carries retryable no and its attempts', async () => {
  const review = await loadFixture('schema-exhausted');
  const classified = classifyReview(review);
  const failure = classified.failures[0];
  assert.equal(failure.status, 'schema_error');
  assert.equal(failure.retryable, false);
  assert.equal(failure.attempts, 3);
  assert.equal(failure.model, 'cc-review');
  assert.equal(failure.classified, true);
});

test('a corrupt diagnostic is unclassified with a named reason, never clean', async () => {
  const review = await loadFixture('corrupt-diag');
  const classified = classifyReview(review);
  const failure = classified.failures[0];
  assert.equal(failure.classified, false);
  assert.deepEqual(failure.evidence, ['diagnostic is not JSON']);
  assert.equal(classified.clean, false);
});

test('infrastructure_failure with no failure records is reported malformed', async () => {
  const review = await loadFixture('malformed-infra');
  const classified = classifyReview(review);
  assert.equal(classified.clean, false);
  assert.match(classified.status, /MALFORMED/);
});

test('unconfirmed result events are not trusted for a terminal reason', () => {
  const events = [
    { type: 'system', subtype: 'init', model: 'cc-review' },
    { type: 'result', subtype: 'success', isError: true, apiErrorStatus: 503, terminalReason: 'api_error' },
    { type: 'result', subtype: 'success', isError: true, apiErrorStatus: 500, terminalReason: 'api_error' },
  ];
  const classified = classifyEvents(events);
  assert.equal(classified.terminalReason, undefined, 'two result events open no confirmed envelope');
  assert.equal(classified.apiErrorStatus, undefined);
  assert.equal(classified.model, 'cc-review');
  assert.equal(classified.unconfirmedResults, 2);
});

test('parseDiagnostic separates absent, non-JSON, eventless, and event shapes', () => {
  assert.equal(parseDiagnostic(undefined).kind, 'absent');
  assert.equal(parseDiagnostic('').kind, 'absent');
  assert.equal(parseDiagnostic('not json').kind, 'nonjson');
  assert.equal(parseDiagnostic('{"events":[]}').kind, 'noevents');
  assert.equal(parseDiagnostic('{"stderr":"boom"}').kind, 'noevents');
  assert.equal(parseDiagnostic('{"events":[{}]}').kind, 'events');
});

test('a missing review.json is an error, not a clean result', async () => {
  await assert.rejects(loadReview(fixtures('empty')), /no review.json found/);
});
