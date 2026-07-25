import test from 'node:test';
import assert from 'node:assert/strict';
import { decideRound, tallyVotes } from '../src/vote-gate.mjs';

const votes = (confirm) => Array.from({ length: 5 }, (_, index) => ({ verdict: index < confirm ? 'confirm' : 'reject' }));

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

test('excludes malformed or incomplete validator outputs', () => {
  assert.throws(() => tallyVotes(votes(3).slice(0, 4)), /exactly 5/);
  assert.throws(() => tallyVotes([...votes(4).slice(0, 4), { verdict: 'infra_error' }]), /structured/);
  assert.throws(() => decideRound(votes(2), 0), /between/);
});
