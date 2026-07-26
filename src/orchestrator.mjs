import { dedupeFindings } from './findings.mjs';
import { decideRound, isCountableVote } from './vote-gate.mjs';
import { groupShards, shardDiff } from './diff-sharder.mjs';

function stageFailure(stage, result) {
  return {
    stage,
    status: result?.status ?? 'infra_error',
    error: result?.error ?? 'runner returned no result',
    ...(typeof result?.diagnostic === 'string' && result.diagnostic.length > 0
      ? { diagnostic: result.diagnostic }
      : {}),
  };
}

function stageOk(result) {
  return result?.status === 'ok';
}

function normalizeAssignments(plan, shards, maxChars) {
  const byIndex = new Map(shards.map((shard) => [shard.index, shard]));
  const requested = Array.isArray(plan?.assignments) ? plan.assignments : [];
  const assignments = requested
    .map((assignment) => {
      const indexes = Array.isArray(assignment?.shardIndexes)
        ? [...new Set(assignment.shardIndexes.filter((index) => Number.isInteger(index) && byIndex.has(index)))]
        : [];
      return indexes.length ? { id: String(assignment.id || `summary-${indexes.join('-')}`), shardIndexes: indexes } : null;
    })
    .filter(Boolean);

  if (!assignments.length) {
    assignments.push(...shards.map((shard) => ({ id: `summary-${shard.index}`, shardIndexes: [shard.index] })));
  } else {
    const covered = new Set(assignments.flatMap((assignment) => assignment.shardIndexes));
    for (const shard of shards) {
      if (!covered.has(shard.index)) assignments.push({ id: `summary-${shard.index}`, shardIndexes: [shard.index] });
    }
  }

  return assignments.flatMap((assignment) => {
    const groups = groupShards(assignment.shardIndexes.map((index) => byIndex.get(index)), { maxChars });
    return groups.map((group, index) => ({
      id: groups.length === 1 ? assignment.id : `${assignment.id}-part-${index + 1}`,
      shardIndexes: group.shardIndexes,
      paths: group.paths,
    }));
  });
}

function assignmentDiff(assignment, shards) {
  const byIndex = new Map(shards.map((shard) => [shard.index, shard]));
  return assignment.shardIndexes.map((index) => byIndex.get(index)?.text || '').join('');
}

function relatedDiff(candidate, diff) {
  const sections = String(diff).split(/(?=^diff --git )/m).filter(Boolean);
  const match = sections.filter((section) => section.split('\n', 1)[0] === `diff --git a/${candidate.path} b/${candidate.path}`);
  return match.length > 0 ? match.join('') : diff;
}

async function collectFiveVotes({ runner, candidate, diff, round, validatorCount, maxAttempts, failures }) {
  const votesBySeat = new Map();
  let attempt = 0;
  while (votesBySeat.size < validatorCount && attempt < maxAttempts) {
    const missingSeats = Array.from({ length: validatorCount }, (_, seat) => seat)
      .filter((seat) => !votesBySeat.has(seat));
    const batch = missingSeats.slice(0, maxAttempts - attempt).map((seat) => {
      const requestAttempt = attempt;
      attempt += 1;
      return runner.run({
        stage: 'validate', model: 'terra', candidate, relatedDiff: relatedDiff(candidate, diff), round, validator: seat, attempt: requestAttempt,
      }).then((validation) => ({ seat, requestAttempt, validation }));
    });
    const results = await Promise.all(batch);
    for (const { seat, requestAttempt, validation } of results) {
      const stage = `validate:${candidate.fingerprint}:${round}:${seat}:attempt-${requestAttempt + 1}`;
      if (!stageOk(validation)) {
        failures.push(stageFailure(stage, validation));
        continue;
      }
      if (!isCountableVote(validation.data)) {
        failures.push({ stage, status: 'schema_error', error: 'validator vote is not semantically countable' });
        continue;
      }
      votesBySeat.set(seat, validation.data);
    }
  }
  return Array.from({ length: validatorCount }, (_, seat) => votesBySeat.get(seat)).filter(Boolean);
}

export async function runReview({
  diff,
  taxonomy,
  runner,
  validatorCount = 5,
  maxVoteRounds = 3,
  maxValidatorAttempts = 15,
  maxShardChars = 12_000,
  maxFinderChars = 40_000,
}) {
  if (!runner || typeof runner.run !== 'function') throw new TypeError('runner.run is required');
  if (!Array.isArray(taxonomy) || taxonomy.length === 0) throw new TypeError('taxonomy must be non-empty');
  if (!Number.isInteger(validatorCount) || validatorCount !== 5) throw new RangeError('review requires exactly five validators');
  if (!Number.isInteger(maxVoteRounds) || maxVoteRounds !== 3) throw new RangeError('review requires exactly three vote rounds');
  if (!Number.isInteger(maxValidatorAttempts) || maxValidatorAttempts < validatorCount) {
    throw new RangeError('maxValidatorAttempts must allow five valid votes');
  }
  if (!Number.isInteger(maxShardChars) || maxShardChars < 1) throw new RangeError('maxShardChars must be positive');
  if (!Number.isInteger(maxFinderChars) || maxFinderChars < maxShardChars) {
    throw new RangeError('maxFinderChars must be at least maxShardChars');
  }

  const failures = [];
  const shards = shardDiff(diff, { maxChars: maxShardChars });
  const plan = await runner.run({
    stage: 'plan',
    model: 'sol',
    shardManifest: shards.map(({ index, paths, text }) => ({ index, paths, chars: text.length })),
    taxonomy,
  });
  if (!stageOk(plan)) return { findings: [], failures: [stageFailure('plan', plan)] };

  const assignments = normalizeAssignments(plan.data, shards, maxShardChars);
  const summaryResults = await Promise.all(assignments.map(async (assignment) => {
    const summary = await runner.run({
      stage: 'summary', model: 'luna', assignment, diff: assignmentDiff(assignment, shards),
    });
    return { assignment, summary };
  }));
  const summaries = [];
  for (const { assignment, summary } of summaryResults) {
    if (!stageOk(summary)) {
      failures.push(stageFailure(`summary:${assignment.id}`, summary));
      continue;
    }
    summaries.push({ assignment: assignment.id, data: summary.data });
  }
  if (summaries.length !== assignments.length) return { findings: [], failures };

  const finderBatches = shards.length > 0
    ? groupShards(shards, { maxChars: maxFinderChars })
    : [{ index: 0, shardIndexes: [], text: '', paths: [] }];
  const finderResults = (await Promise.all(taxonomy.map(async (dimension) => {
    const results = [];
    for (const batch of finderBatches) {
      results.push({
        dimension,
        batch,
        finder: await runner.run({
          stage: 'find', model: 'terra', taxonomy: dimension, paths: batch.paths, diff: batch.text, summaries,
        }),
      });
    }
    return results;
  }))).flat();
  const candidates = [];
  for (const { dimension, batch, finder } of finderResults) {
    const dimensionId = typeof dimension === 'string' ? dimension : dimension?.id ?? 'unknown';
    const stage = `find:${dimensionId}:batch-${batch.index}`;
    if (!stageOk(finder)) {
      failures.push(stageFailure(stage, finder));
      continue;
    }
    if (!Array.isArray(finder.data)) {
      failures.push({ stage, status: 'schema_error', error: 'finder data must be an array' });
      continue;
    }
    candidates.push(...finder.data);
  }

  const accepted = [];
  for (const candidate of dedupeFindings(candidates)) {
    let outcome;
    const voteRounds = [];
    for (let round = 1; round <= maxVoteRounds; round += 1) {
      const votes = await collectFiveVotes({
        runner, candidate, diff, round, validatorCount, maxAttempts: maxValidatorAttempts, failures,
      });
      if (votes.length !== validatorCount) {
        failures.push({
          stage: `validate:${candidate.fingerprint}:${round}`,
          status: 'infra_error',
          error: `could not collect ${validatorCount} valid votes after ${maxValidatorAttempts} attempts`,
        });
        outcome = { decision: 'infra_error' };
        break;
      }
      voteRounds.push(votes);
      try {
        outcome = decideRound(votes, round, { validatorCount, maxRounds: maxVoteRounds });
      } catch (error) {
        failures.push({ stage: `validate:${candidate.fingerprint}:${round}`, status: 'schema_error', error: error.message });
        outcome = { decision: 'infra_error' };
        break;
      }
      if (outcome.decision !== 'revote') break;
    }

    if (outcome?.decision === 'accept') {
      accepted.push(candidate);
    } else if (outcome?.decision === 'adjudicate') {
      const adjudication = await runner.run({
        stage: 'adjudicate', model: 'sol', candidate, voteRounds,
      });
      if (!stageOk(adjudication)) {
        failures.push(stageFailure(`adjudicate:${candidate.fingerprint}`, adjudication));
      } else if (adjudication.data?.decision === 'accept') {
        accepted.push(candidate);
      } else if (adjudication.data?.decision !== 'reject') {
        failures.push({ stage: `adjudicate:${candidate.fingerprint}`, status: 'schema_error', error: 'invalid adjudication decision' });
      }
    }
  }
  return { findings: accepted, failures };
}
