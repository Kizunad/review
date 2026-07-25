const VALID_VERDICTS = new Set(['confirm', 'reject']);

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
  for (const vote of votes) {
    const verdict = typeof vote === 'string' ? vote : vote?.verdict;
    if (!VALID_VERDICTS.has(verdict)) {
      throw new TypeError('only structured confirm or reject votes may be tallied');
    }
    if (verdict === 'confirm') confirm += 1;
    else reject += 1;
  }
  return { confirm, reject, total: votes.length };
}

export function decideRound(votes, round, { validatorCount = 5, maxRounds = 3 } = {}) {
  assertRound(round, maxRounds);
  const tally = tallyVotes(votes, validatorCount);
  if (tally.confirm >= 4) return { decision: 'accept', ...tally };
  if (tally.reject >= 4) return { decision: 'reject', ...tally };
  return { decision: round === maxRounds ? 'adjudicate' : 'revote', ...tally };
}
