import test from 'node:test';
import assert from 'node:assert/strict';
import { validAdjudication } from '../src/review-contract.mjs';
import {
  calibrateLevel,
  decideRound,
  isCountableVote,
  tallyVotes,
} from '../src/vote-gate.mjs';

const fingerprint = 'a'.repeat(64);
function votes(confirm, levels = Array.from({ length: 5 }, (_, index) => (index < confirm ? 'major' : 'suggestion'))) {
  return Array.from({ length: 5 }, (_, index) => ({
    version: 'v2',
    candidateFingerprint: fingerprint,
    verdict: index < confirm ? 'confirm' : 'reject',
    reachable: index < confirm,
    level: levels[index],
    evidence: 'independent evidence',
    reason: 'independent reason',
  }));
}

function structuralVotes(split) {
  return Array.from({ length: 5 }, (_, index) => ({
    version: 'v2',
    candidateFingerprint: fingerprint,
    verdict: index < split ? 'split' : 'reject',
    reachable: false,
    level: 'suggestion',
    evidence: 'independent cluster evidence',
    reason: 'independent structural rationale',
  }));
}

test('accepts four or five confirmations and rejects four or five rejections', () => {
  assert.equal(decideRound(votes(4), 1).decision, 'accept');
  assert.equal(decideRound(votes(5), 1).decision, 'accept');
  assert.equal(decideRound(votes(1), 1).decision, 'reject');
  assert.equal(decideRound(votes(0), 1).decision, 'reject');
});

test('revotes split votes until the third round then adjudicates', () => {
  assert.equal(decideRound(votes(2), 1).decision, 'revote');
  assert.equal(decideRound(votes(3), 2).decision, 'revote');
  assert.equal(decideRound(votes(2), 3).decision, 'adjudicate');
});

test('separates structural split votes from defect existence votes', () => {
  assert.deepEqual(tallyVotes(structuralVotes(4)), {
    confirm: 0,
    reject: 1,
    split: 4,
    total: 5,
  });
  assert.equal(decideRound(structuralVotes(4), 1).decision, 'split');
  assert.equal(decideRound(structuralVotes(3), 1).decision, 'revote');
  assert.equal(decideRound(structuralVotes(3), 3).decision, 'structural_failure');
  assert.throws(() => calibrateLevel(structuralVotes(4)), /four confirming/);
});

test('calibrates the highest level supported by at least four seats', () => {
  assert.equal(calibrateLevel(votes(4, ['blocker', 'blocker', 'blocker', 'blocker', 'suggestion'])), 'blocker');
  assert.equal(calibrateLevel(votes(4, ['blocker', 'blocker', 'blocker', 'major', 'suggestion'])), 'major');
  assert.equal(calibrateLevel(votes(4, ['major', 'major', 'major', 'minor', 'suggestion'])), 'minor');
  assert.equal(calibrateLevel(votes(4, ['minor', 'minor', 'minor', 'suggestion', 'suggestion'])), 'suggestion');
  assert.equal(decideRound(votes(4, ['major', 'major', 'major', 'suggestion', 'suggestion']), 1).level, 'suggestion');
});

test('excludes malformed, incomplete, and contradictory votes', () => {
  assert.throws(() => tallyVotes(votes(3).slice(0, 4)), /exactly 5/);
  assert.throws(
    () => tallyVotes([...votes(4).slice(0, 4), { ...votes(4)[4], verdict: 'infra_error' }]),
    /structured votes/,
  );
  assert.throws(
    () => tallyVotes([...votes(4).slice(0, 4), { ...votes(4)[4], verdict: 'confirm', reachable: false }]),
    /structured votes/,
  );
  const missingLevel = { ...votes(4)[4] };
  delete missingLevel.level;
  assert.throws(
    () => tallyVotes([...votes(4).slice(0, 4), missingLevel]),
    /valid level/,
  );
  assert.throws(
    () => tallyVotes([...votes(4).slice(0, 4), { ...votes(4)[4], level: 'critical' }]),
    /valid level/,
  );
  assert.throws(
    () => tallyVotes([...votes(4).slice(0, 4), { ...votes(4)[4], level: 'major' }]),
    /structured votes/,
  );
  assert.throws(
    () => tallyVotes([...votes(4).slice(0, 4), { ...votes(4)[4], version: 'v1' }]),
    /structured votes/,
  );
  assert.throws(
    () => tallyVotes([...votes(4).slice(0, 4), { ...votes(4)[4], extra: true }]),
    /structured votes/,
  );
  assert.doesNotThrow(
    () => tallyVotes([...votes(4).slice(0, 4), { ...votes(4)[4], level: 'suggestion' }]),
  );
  assert.throws(() => decideRound(votes(2), 0), /between/);
});

test('shares exact v2 vote and adjudication semantics across review stages', () => {
  const confirmation = votes(4)[0];
  assert.equal(isCountableVote(confirmation), true);
  assert.equal(isCountableVote(confirmation, fingerprint), true);
  assert.equal(isCountableVote(confirmation, 'b'.repeat(64)), false);
  assert.equal(isCountableVote({ ...confirmation, evidence: '😀'.repeat(4_000) }), true);
  assert.equal(isCountableVote({ ...confirmation, evidence: '😀'.repeat(4_001) }), false);
  assert.equal(isCountableVote({ ...confirmation, extra: true }), false);

  const accepted = {
    version: 'v2',
    candidateFingerprint: fingerprint,
    decision: 'accept',
    level: 'major',
    reason: 'defect survives refutation',
  };
  const rejected = {
    version: 'v2',
    candidateFingerprint: fingerprint,
    decision: 'reject',
    reason: 'defect is not proven',
  };
  assert.equal(validAdjudication(accepted, fingerprint), true);
  assert.equal(validAdjudication(rejected, fingerprint), true);
  assert.equal(validAdjudication({ ...rejected, level: 'suggestion' }, fingerprint), false);
  assert.equal(validAdjudication({ ...accepted, level: undefined }, fingerprint), false);
  assert.equal(validAdjudication({ ...accepted, reason: '😀'.repeat(4_001) }, fingerprint), false);
  assert.equal(validAdjudication({ ...accepted, extra: true }, fingerprint), false);
  assert.equal(validAdjudication(accepted, 'b'.repeat(64)), false);
});
