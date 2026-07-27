import { REVIEW_LEVELS } from './findings.mjs';
import { isCountableVote } from './review-contract.mjs';

export { isCountableVote };

function assertRound(round, maxRounds) {
  if (!Number.isInteger(round) || round < 1 || round > maxRounds) {
    throw new RangeError(`round must be between 1 and ${maxRounds}`);
  }
}

export function tallyVotes(votes, validatorCount = 5) {
  if (!Array.isArray(votes) || votes.length !== validatorCount) {
    throw new Error(`exactly ${validatorCount} validator votes are required`);
  }

  let confirm = 0;
  let reject = 0;
  let split = 0;
  for (const vote of votes) {
    if (!isCountableVote(vote)) {
      throw new TypeError('only structured votes with a valid level and semantically reachable confirm, reject, or split verdict may be tallied');
    }
    if (vote.verdict === 'confirm') confirm += 1;
    else if (vote.verdict === 'reject') reject += 1;
    else split += 1;
  }
  return {
    confirm, reject, split, total: votes.length,
  };
}

export function calibrateLevel(votes, validatorCount = 5) {
  tallyVotes(votes, validatorCount);
  const confirmations = votes.filter((vote) => vote.verdict === 'confirm');
  for (const [index, level] of REVIEW_LEVELS.entries()) {
    const support = confirmations.filter((vote) => REVIEW_LEVELS.indexOf(vote.level) <= index).length;
    if (support >= 4) return level;
  }
  throw new Error('four confirming validator seats must support a final level');
}

export function decideRound(votes, round, { validatorCount = 5, maxRounds = 3 } = {}) {
  assertRound(round, maxRounds);
  const tally = tallyVotes(votes, validatorCount);
  if (tally.split >= 4) return { decision: 'split', ...tally };
  if (tally.confirm >= 4) return { decision: 'accept', level: calibrateLevel(votes, validatorCount), ...tally };
  if (tally.reject >= 4) return { decision: 'reject', ...tally };
  if (round === maxRounds && tally.split > 0) return { decision: 'structural_failure', ...tally };
  return { decision: round === maxRounds ? 'adjudicate' : 'revote', ...tally };
}
