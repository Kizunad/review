import test from 'node:test';
import assert from 'node:assert/strict';
import { describeCountableVoteFailure, validAdjudication } from '../src/review-contract.mjs';
import { isCountableVote } from '../src/vote-gate.mjs';

const fingerprint = 'a'.repeat(64);
const otherFingerprint = 'b'.repeat(64);

function countableVote(overrides = {}) {
  return {
    version: 'v2',
    candidateFingerprint: fingerprint,
    verdict: 'confirm',
    reachable: true,
    level: 'major',
    evidence: 'independent evidence',
    reason: 'independent reason',
    ...overrides,
  };
}

test('a countable vote reports no failure', () => {
  assert.equal(describeCountableVoteFailure(countableVote(), fingerprint), null);
  assert.equal(isCountableVote(countableVote(), fingerprint), true);
});

test('reports a missing field, naming the delta and the exact field set', () => {
  const vote = countableVote();
  delete vote.level;
  const message = describeCountableVoteFailure(vote, fingerprint);
  assert.match(message, /wrong field set/);
  assert.match(message, /missing level/);
  assert.match(message, /expected exactly candidateFingerprint, evidence, level, reachable, reason, verdict, version/);
  assert.doesNotMatch(message, /coupling|malformed candidateFingerprint|must be "v2"/);
});

test('reports an unexpected field with the untrusted key name JSON-encoded', () => {
  const vote = countableVote({ 'why\ninjected': true });
  const message = describeCountableVoteFailure(vote, fingerprint);
  assert.match(message, /wrong field set/);
  assert.match(message, /unexpected "why\\ninjected"/);
  assert.doesNotMatch(message, /why\ninjected/, 'a key name from model output must never carry a raw newline into the prompt');
});

test('reports version not v2', () => {
  const message = describeCountableVoteFailure(countableVote({ version: 'v1' }), fingerprint);
  assert.match(message, /has version "v1"/);
  assert.match(message, /must be "v2"/);
  assert.doesNotMatch(message, /wrong field set|malformed candidateFingerprint|does not equal/);
});

test('reports a malformed candidateFingerprint', () => {
  const message = describeCountableVoteFailure(countableVote({ candidateFingerprint: 'not-a-fingerprint' }), fingerprint);
  assert.match(message, /malformed candidateFingerprint/);
  assert.match(message, /64 lowercase hex/);
  assert.doesNotMatch(message, /does not equal the supplied cluster fingerprint/);
});

test('reports candidateFingerprint not equal to the supplied cluster fingerprint, showing both', () => {
  const message = describeCountableVoteFailure(countableVote({ candidateFingerprint: otherFingerprint }), fingerprint);
  assert.match(message, /does not equal the supplied cluster fingerprint/);
  assert.ok(message.includes(otherFingerprint), 'the observed fingerprint must be shown');
  assert.ok(message.includes(fingerprint), 'the supplied cluster fingerprint must be shown');
  assert.doesNotMatch(message, /malformed/);
});

test('reports an unknown verdict', () => {
  const message = describeCountableVoteFailure(countableVote({ verdict: 'maybe' }), fingerprint);
  assert.match(message, /has verdict "maybe"/);
  assert.match(message, /must be "confirm", "reject", or "split"/);
  assert.doesNotMatch(message, /coupling/);
});

test('reports reachable not a boolean', () => {
  const message = describeCountableVoteFailure(countableVote({ reachable: 'yes' }), fingerprint);
  assert.match(message, /non-boolean reachable "yes"/);
});

test('reports an unknown level', () => {
  const message = describeCountableVoteFailure(countableVote({ level: 'critical' }), fingerprint);
  assert.match(message, /unknown level "critical"/);
  assert.match(message, /blocker, major, minor, suggestion/);
});

test('reports a confirm vote with reachable=false as the coupling violation', () => {
  const message = describeCountableVoteFailure(countableVote({ verdict: 'confirm', reachable: false }), fingerprint);
  assert.match(message, /violates the reachable\/level coupling/);
  assert.match(message, /confirm requires reachable=true/);
  assert.match(message, /observed verdict="confirm", reachable=false/);
});

test('reports a reject vote with a real level, naming the verdict and level it saw', () => {
  const message = describeCountableVoteFailure(countableVote({ verdict: 'reject', reachable: false, level: 'minor' }), fingerprint);
  assert.match(message, /violates the reachable\/level coupling/);
  assert.match(message, /reject and split require reachable=false and level "suggestion"/);
  assert.match(message, /observed verdict="reject", reachable=false, level="minor"/);
  assert.doesNotMatch(message, /wrong field set/);
});

test('reports evidence over the length bound by count, never by content', () => {
  const message = describeCountableVoteFailure(countableVote({ evidence: 'x'.repeat(4_001) }), fingerprint);
  assert.match(message, /has evidence of 4001 characters/);
  assert.doesNotMatch(message, /xxxx/, 'the evidence body must never be echoed into the prompt');
});

test('reports reason over the length bound by count', () => {
  const message = describeCountableVoteFailure(countableVote({ reason: 'y'.repeat(4_001) }), fingerprint);
  assert.match(message, /has reason of 4001 characters/);
});

test('an undefined supplied fingerprint skips the equality check, matching the boolean gate', () => {
  const mismatched = countableVote({ candidateFingerprint: otherFingerprint });
  assert.equal(describeCountableVoteFailure(mismatched, undefined), null);
  assert.equal(isCountableVote(mismatched), true);
});

test('every rejected vote records the observed verdict, reachable, and level', () => {
  const cases = [
    countableVote({ version: 'v1' }),
    countableVote({ candidateFingerprint: otherFingerprint }),
    countableVote({ verdict: 'reject', reachable: false, level: 'minor' }),
    countableVote({ evidence: 'x'.repeat(4_001) }),
  ];
  for (const vote of cases) {
    const message = describeCountableVoteFailure(vote, fingerprint);
    assert.match(message, /observed verdict=/);
    assert.match(message, /reachable=/);
    assert.match(message, /level=/);
  }
});

test('the boolean gate and the failure message never diverge', () => {
  const valid = countableVote();
  const invalid = countableVote({ verdict: 'reject', reachable: false, level: 'minor' });
  assert.equal(isCountableVote(valid, fingerprint), describeCountableVoteFailure(valid, fingerprint) === null);
  assert.equal(isCountableVote(invalid, fingerprint), describeCountableVoteFailure(invalid, fingerprint) === null);

  const rejected = {
    version: 'v2',
    candidateFingerprint: fingerprint,
    decision: 'reject',
    reason: 'defect is not proven',
  };
  assert.equal(validAdjudication(rejected, fingerprint), true);
  assert.equal(validAdjudication({ ...rejected, level: 'suggestion' }, fingerprint), false);
});
