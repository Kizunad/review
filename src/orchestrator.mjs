import { compareStrings } from './deterministic.mjs';
import {
  canonicalizeFinderCandidates,
  consolidateFindings,
  dedupeFindings,
  MAX_CONSOLIDATION_CANDIDATES,
} from './findings.mjs';
import { validAdjudication } from './review-contract.mjs';
import { decideRound, isCountableVote } from './vote-gate.mjs';
import { groupShards, shardDiff } from './diff-sharder.mjs';

const MAX_FINDER_CONCURRENCY = 2;
// Summary calls all land on the cheap pool behind the relay. Firing every
// assignment at once (a 1 MiB diff is ~88 assignments) overloads that pool:
// per-request time-to-first-byte then exceeds the Cloudflare tunnel's ~100s
// origin timeout, so the relay returns 524 before any streamed byte arrives.
// The finder stage is already bounded this way for the same reason, and a
// bounded lane serializes assignments in deterministic order.
const MAX_SUMMARY_CONCURRENCY = 2;
const MAX_FAILURE_SAMPLES = 4;
const MAX_FAILURE_TEXT = 4_000;
const FAILURE_STATUSES = ['infra_error', 'schema_error'];

// Bounded batch-failure budget for the finder stage - the only stage that fans
// out into independent slices of the corpus (one call per taxonomy dimension x
// diff batch), so the only one where losing a call loses a bounded fraction of
// the review rather than the review itself.
//
// The upstream model refuses a bounded fraction of batches outright: it keeps
// answering with a non-contract shape ("finder data must be an array",
// "candidate fields do not match the v2 contract") even after the schema-retry
// loop has fed the field-level errors back three times. Measured on Bong that
// stubborn rate is ~5% per batch, and one review of that repository runs 112
// finder batches (8 dimensions x 14 batches); Bong#1308 lost 3 of them and threw
// away all 112 batches' worth of work. Under an all-or-nothing policy the odds
// that a whole review comes back clean are 0.95^112 ~= 0.2%, so the run and
// every retry of it report infrastructure_failure forever. All-or-nothing is not
// a strictness setting at that scale, it is an outage.
//
// A review with a small, NAMED hole in its coverage is worth more than no review
// at all. Batches that fail within this budget are therefore dropped from the
// corpus and booked in coverageGaps; lose more than the budget and the stage
// still fails closed, because at that point the surviving corpus is no longer a
// fair sample of the diff. The engine only keeps the books - it never softens
// the decision for a gap, and a consumer that wants zero gaps reads coverageGaps
// and tightens its own gate.
//
// Every other stage stays strict, and not only the single-call ones (plan,
// consolidate, adjudicate) that have no second batch to carry the review:
// summary is budgeted too (see the summary allowance in runReview), but a
// summary loss is only a nameable hole when the dropped shards are excluded
// from the finder corpus and booked in coverageGaps - a finder batch that
// still read an unsummarised shard's paths would degrade the whole corpus
// silently, which is exactly the all-or-nothing failure this budget exists to
// replace.
export const FINDER_BATCH_FAILURE_BUDGET = 0.08;

// Floor, so the tolerated share never exceeds the budget itself: 112 batches
// tolerate 8 (7.1%). The floor is clamped to one because an unclamped floor
// collapses to zero below 13 batches - 8 batches, a standard review's count,
// floor to 0 (0.64) and the advertised 8% budget does not exist at the batch
// count the fleet actually runs. One batch of tolerance is the smallest honest
// allowance for any run that fans out at all.
function batchFailureAllowance(total, budget = FINDER_BATCH_FAILURE_BUDGET) {
  return Math.max(1, Math.floor(total * budget));
}

function budgetExceededFailure(stage, failed, total, allowance, budget = FINDER_BATCH_FAILURE_BUDGET) {
  return {
    stage,
    status: 'infra_error',
    error: `${failed}/${total} failed batches exceeds budget ${Number((budget * 100).toFixed(4))}%`
      + ` (at most ${allowance} of ${total} batch(es) may fail)`,
  };
}

// The structured fields a stage result can carry (the confirmed API error
// envelope, the model called, attempts consumed, determinism) ride through every
// record type - failure and gap alike - so a record's cause never depends on
// substring-matching the collapsed error string. Absent fields stay absent: a
// plain infra failure has no status to claim.
function structuredFields(source = {}) {
  return {
    ...(Number.isInteger(source.apiErrorStatus) ? { apiErrorStatus: source.apiErrorStatus } : {}),
    ...(typeof source.apiErrorMessage === 'string' && source.apiErrorMessage.length > 0
      ? { apiErrorMessage: source.apiErrorMessage } : {}),
    ...(typeof source.terminalReason === 'string' && source.terminalReason.length > 0
      ? { terminalReason: source.terminalReason } : {}),
    ...(typeof source.model === 'string' && source.model.length > 0 ? { model: source.model } : {}),
    ...(Number.isSafeInteger(source.attempts) && source.attempts >= 0 ? { attempts: source.attempts } : {}),
    ...(typeof source.retryable === 'boolean' ? { retryable: source.retryable } : {}),
  };
}

// paths names what the dropped batch was covering, so a gap can be read against
// the diff instead of being an opaque batch number. source is the runner result
// that failed; its diagnostic and structured fields ride on the gap so a review
// that ships with a blind lens says why it went blind.
function coverageGap(stage, batch, paths, error, source = {}) {
  return {
    stage,
    batch,
    paths: Array.isArray(paths) ? [...paths] : [],
    error: boundedFailureText(error),
    ...(typeof source?.diagnostic === 'string' && source.diagnostic.length > 0
      ? { diagnostic: source.diagnostic } : {}),
    ...structuredFields(source),
  };
}

// Model names sent by every stage.
//
// These are ROUTING PLACEHOLDERS, not provider tiers. The upstream behind this
// provider fails PER MODEL and the failing model ROTATES; encoding a real tier
// here (first terra, then luna, then sol) turned every rotation into a source
// edit plus a release plus a consumer pin bump. An allow-list of real tiers has
// the same flaw one level up: adding a tier is still a release. So the engine
// now sends stable placeholder names and the relay maps each one to whichever
// upstream model is currently healthy - re-pointable from the relay's web UI
// with zero code changes. Membership is the relay's concern; this side checks
// SHAPE only (and the leading alphanumeric keeps a name from ever parsing as a
// CLI flag).
//
//   cc-review       judgment stages: plan, find, validate, consolidate, adjudicate
//   cc-review-lite  the cheap summary stage
//
// REVIEW_MODEL / REVIEW_MODEL_LITE still override per run for canaries and
// bisection, bypassing the relay mapping with a literal upstream name.
export const DEFAULT_REVIEWER_MODEL = 'cc-review';
export const DEFAULT_LITE_MODEL = 'cc-review-lite';

const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

function resolveModel(environment, key, fallback) {
  const requested = environment?.[key];
  if (requested == null || requested === '') return fallback;
  // Fail closed on malformed names - a typo must not silently fall back to the
  // default and produce a review nobody realises ran on the wrong model.
  if (typeof requested !== 'string' || !MODEL_NAME.test(requested)) {
    throw new Error(`${key} must match ${MODEL_NAME}; received ${JSON.stringify(requested)}`);
  }
  return requested;
}

export function resolveReviewerModel(environment = process.env) {
  return resolveModel(environment, 'REVIEW_MODEL', DEFAULT_REVIEWER_MODEL);
}

export function resolveLiteModel(environment = process.env) {
  return resolveModel(environment, 'REVIEW_MODEL_LITE', DEFAULT_LITE_MODEL);
}

export const REVIEWER_MODEL = resolveReviewerModel();
export const LITE_MODEL = resolveLiteModel();

function boundedFailureText(value, limit = MAX_FAILURE_TEXT) {
  const text = String(value ?? 'runner returned no result');
  const symbols = [...text];
  return symbols.length <= limit ? text : `${symbols.slice(0, Math.max(0, limit - 1)).join('')}…`;
}

function aggregateFinderFailures(taxonomy, finderBatches, records) {
  const aggregates = [];
  for (const dimension of taxonomy) {
    const dimensionId = typeof dimension === 'string' ? dimension : dimension?.id ?? 'unknown';
    const scoped = records.filter((record) => record.dimensionId === dimensionId);
    for (const status of FAILURE_STATUSES) {
      const failures = scoped.filter((record) => record.status === status);
      if (failures.length === 0) continue;
      const samples = failures.slice(0, MAX_FAILURE_SAMPLES).map((failure) => {
        const candidate = failure.candidateIndex === undefined ? '' : `:candidate-${failure.candidateIndex}`;
        return `batch-${failure.batchIndex}${candidate}: ${boundedFailureText(failure.error, 512)}`;
      });
      const omitted = failures.length - samples.length;
      const failedBatches = new Set(failures.map((failure) => failure.batchIndex)).size;
      const suffix = omitted > 0 ? `; omitted ${omitted} occurrence(s)` : '';
      const diagnosticSamples = failures
        .map((failure) => failure.diagnostic)
        .filter((diagnostic) => typeof diagnostic === 'string' && diagnostic.length > 0)
        .slice(0, MAX_FAILURE_SAMPLES);
      // Distinct statuses and models across the collapsed batches - the census
      // surface: N batches dying on the same 402 reads differently from a
      // mixed-status failure, and judgment-stage vs lite-pool failures are
      // different outages.
      const apiErrorStatuses = [...new Set(
        failures.map((failure) => failure.apiErrorStatus).filter((value) => Number.isInteger(value)),
      )].sort((left, right) => left - right);
      const models = [...new Set(
        failures.map((failure) => failure.model).filter((value) => typeof value === 'string' && value.length > 0),
      )];
      aggregates.push({
        stage: `find:${dimensionId}`,
        status,
        error: boundedFailureText(
          `${failures.length} occurrence(s) in ${failedBatches}/${finderBatches.length} failed batch(es); samples: ${samples.join(' | ')}${suffix}`,
        ),
        ...(diagnosticSamples.length > 0
          ? { diagnostic: boundedFailureText(diagnosticSamples.join('\n')) }
          : {}),
        ...(apiErrorStatuses.length > 0 ? { apiErrorStatuses } : {}),
        ...(models.length > 0 ? { models } : {}),
      });
    }
  }
  return aggregates;
}

async function mapBounded(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(items[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function stageFailure(stage, result) {
  return {
    stage,
    status: result?.status ?? 'infra_error',
    error: result?.error ?? 'runner returned no result',
    ...(typeof result?.diagnostic === 'string' && result.diagnostic.length > 0
      ? { diagnostic: result.diagnostic }
      : {}),
    ...structuredFields(result),
  };
}

function stageOk(result) {
  return result?.status === 'ok';
}

function normalizeAssignments(plan, shards, maxChars) {
  const byIndex = new Map(shards.map((shard) => [shard.index, shard]));
  const requested = Array.isArray(plan?.assignments) ? plan.assignments : [];
  // The plan is a work-splitting suggestion, not a contract: the engine owns
  // the partition. First-wins claiming keeps each shard in exactly one
  // assignment - an overlapping plan would otherwise summarize the same shard
  // twice (wasted calls, inflated summary budget N) and let a failed
  // assignment book a gap whose paths the finder corpus still contains.
  const claimed = new Set();
  const assignments = requested
    .map((assignment) => {
      const indexes = Array.isArray(assignment?.shardIndexes)
        ? [...new Set(assignment.shardIndexes.filter((index) => Number.isInteger(index) && byIndex.has(index) && !claimed.has(index)))]
        : [];
      for (const index of indexes) claimed.add(index);
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

function splitClusterMembers(candidate) {
  if (candidate.memberFingerprints.length <= 1) return [];
  return candidate.validationCandidates
    .map((member) => ({
      ...member,
      memberFingerprints: [member.fingerprint],
      validationCandidates: [member],
    }))
    .sort((left, right) => compareStrings(left.fingerprint, right.fingerprint));
}

async function collectFiveVotes({ runner, candidate, diff, round, validatorCount, maxAttempts, failures }) {
  const votesBySeat = new Map();
  const attemptFailures = [];
  let attempt = 0;
  while (votesBySeat.size < validatorCount && attempt < maxAttempts) {
    const missingSeats = Array.from({ length: validatorCount }, (_, seat) => seat)
      .filter((seat) => !votesBySeat.has(seat));
    const batch = missingSeats.slice(0, maxAttempts - attempt).map((seat) => {
      const requestAttempt = attempt;
      attempt += 1;
      return runner.run({
        stage: 'validate', model: REVIEWER_MODEL, candidate,
        relatedDiff: relatedDiff(candidate, diff), round, validator: seat, attempt: requestAttempt,
      }).then((validation) => ({ seat, requestAttempt, validation }));
    });
    const results = await Promise.all(batch);
    for (const { seat, requestAttempt, validation } of results) {
      const stage = `validate:${candidate.fingerprint}:${round}:${seat}:attempt-${requestAttempt + 1}`;
      if (!stageOk(validation)) {
        attemptFailures.push(stageFailure(stage, validation));
        continue;
      }
      if (!isCountableVote(validation.data)
        || validation.data.candidateFingerprint !== candidate.fingerprint
        || (validation.data.verdict === 'split' && candidate.memberFingerprints.length === 1)) {
        attemptFailures.push({ stage, status: 'schema_error', error: 'validator vote is not semantically countable for this cluster or does not match the candidate fingerprint' });
        continue;
      }
      votesBySeat.set(seat, validation.data);
    }
  }
  if (votesBySeat.size < validatorCount) failures.push(...attemptFailures);
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
  const coverageGaps = [];
  const shards = shardDiff(diff, { maxChars: maxShardChars });
  const plan = await runner.run({
    stage: 'plan',
    model: REVIEWER_MODEL,
    shardManifest: shards.map(({ index, paths, text }) => ({ index, paths, chars: text.length })),
    taxonomy,
  });
  // Single-shot stage: no budget applies, one failed call is the whole stage.
  if (!stageOk(plan)) return { findings: [], failures: [stageFailure('plan', plan)], coverageGaps };

  const assignments = normalizeAssignments(plan.data, shards, maxShardChars);
  const summaryResults = await mapBounded(
    assignments,
    MAX_SUMMARY_CONCURRENCY,
    async (assignment) => {
      const summary = await runner.run({
        stage: 'summary', model: LITE_MODEL, assignment, diff: assignmentDiff(assignment, shards),
      });
      return { assignment, summary };
    },
  );
  const summaryFailures = [];
  const summaries = [];
  const summarisedShardIndexes = new Set();
  for (const { assignment, summary } of summaryResults) {
    if (!stageOk(summary)) {
      summaryFailures.push({ assignment, summary });
      continue;
    }
    summaries.push({ assignment: assignment.id, data: summary.data });
    for (const index of assignment.shardIndexes) summarisedShardIndexes.add(index);
  }

  // Summary is fanned out per assignment but is an INPUT to every finder batch,
  // so a missing one used to be all-or-nothing: with N assignments and per-call
  // success p, a review survived with probability p^N. That is an outage at
  // fleet scale - with N >= 12 and p around 0.5, reviews die at summary while
  // the pool measures healthy per call. The runner already retries each call
  // (STAGE_ATTEMPTS=3 with 20s/40s backoff, plus the schema-repair budget), so
  // the multiplier was the gate, not the transport.
  //
  // A missing summary is now a NAMED hole instead of a fatal one, under the
  // same budget mechanism the finder stage already uses: within budget, the
  // failed assignment's shards are dropped from the finder corpus and their
  // paths are booked in coverageGaps, so a shipped review honestly admits
  // which files nobody summarised. Lose more than the budget and the stage
  // still fails closed - past that point the surviving corpus is no longer a
  // fair sample of the diff.
  const summaryAllowance = batchFailureAllowance(assignments.length);
  if (summaryFailures.length > summaryAllowance) {
    failures.push(
      budgetExceededFailure('summary', summaryFailures.length, assignments.length, summaryAllowance),
      ...summaryFailures.map(({ assignment, summary }) => stageFailure(`summary:${assignment.id}`, summary)),
    );
    return { findings: [], failures, coverageGaps };
  }
  for (const { assignment, summary } of summaryFailures) {
    coverageGaps.push(coverageGap('summary', assignment.id, assignment.paths, summary?.error ?? 'runner returned no result', summary));
  }
  const finderShards = shards.filter((shard) => summarisedShardIndexes.has(shard.index));
  const finderBatches = finderShards.length > 0
    ? groupShards(finderShards, { maxChars: maxFinderChars })
    : [{ index: 0, shardIndexes: [], text: '', paths: [] }];
  const finderResults = (await mapBounded(
    taxonomy,
    MAX_FINDER_CONCURRENCY,
    async (dimension) => {
      const results = [];
      for (const batch of finderBatches) {
        results.push({
          dimension,
          batch,
          finder: await runner.run({
            stage: 'find', model: REVIEWER_MODEL, taxonomy: dimension, paths: batch.paths, diff: batch.text, summaries,
          }),
        });
      }
      return results;
    },
  )).flat();
  const candidates = [];
  const finderFailureRecords = [];
  for (const { dimension, batch, finder } of finderResults) {
    const dimensionId = typeof dimension === 'string' ? dimension : dimension?.id ?? 'unknown';
    if (!stageOk(finder)) {
      finderFailureRecords.push({
        dimensionId,
        batchIndex: batch.index,
        batchPaths: batch.paths,
        status: FAILURE_STATUSES.includes(finder?.status) ? finder.status : 'infra_error',
        error: finder?.error ?? 'runner returned no result',
        diagnostic: finder?.diagnostic,
        ...structuredFields(finder),
      });
      continue;
    }
    if (!Array.isArray(finder.data)) {
      finderFailureRecords.push({
        dimensionId,
        batchIndex: batch.index,
        batchPaths: batch.paths,
        status: 'schema_error',
        error: 'finder data must be an array',
      });
      continue;
    }
    try {
      candidates.push(...canonicalizeFinderCandidates(finder.data, dimension));
    } catch (error) {
      finderFailureRecords.push({
        dimensionId,
        batchIndex: batch.index,
        batchPaths: batch.paths,
        status: 'schema_error',
        error: error.message,
      });
    }
  }
  // Exactly one record per failed (dimension, batch) pair above, so the record
  // count IS the failed batch count and can be compared against the budget.
  const finderBatchCount = taxonomy.length * finderBatches.length;
  const finderAllowance = batchFailureAllowance(finderBatchCount);
  if (finderFailureRecords.length > finderAllowance) {
    failures.push(
      budgetExceededFailure('find', finderFailureRecords.length, finderBatchCount, finderAllowance),
      ...aggregateFinderFailures(taxonomy, finderBatches, finderFailureRecords),
    );
    return { findings: [], failures, coverageGaps };
  }
  for (const record of finderFailureRecords) {
    coverageGaps.push(coverageGap(`find:${record.dimensionId}`, record.batchIndex, record.batchPaths, record.error, record));
  }

  const exactCandidates = dedupeFindings(candidates);
  if (exactCandidates.length === 0) return { findings: [], failures, coverageGaps };
  if (exactCandidates.length > MAX_CONSOLIDATION_CANDIDATES) {
    failures.push({
      stage: 'consolidate',
      status: 'schema_error',
      error: `consolidation input must contain at most ${MAX_CONSOLIDATION_CANDIDATES} candidates`,
    });
    return { findings: [], failures, coverageGaps };
  }

  const consolidation = await runner.run({
    stage: 'consolidate', model: REVIEWER_MODEL, candidates: exactCandidates,
  });
  // Single-shot stage: no budget applies.
  if (!stageOk(consolidation)) {
    failures.push(stageFailure('consolidate', consolidation));
    return { findings: [], failures, coverageGaps };
  }
  let consolidatedCandidates;
  try {
    consolidatedCandidates = consolidateFindings(exactCandidates, consolidation.data);
  } catch (error) {
    failures.push({ stage: 'consolidate', status: 'schema_error', error: error.message });
    return { findings: [], failures, coverageGaps };
  }

  const accepted = [];
  const pending = [...consolidatedCandidates];
  while (pending.length > 0) {
    const candidate = pending.shift();
    let outcome;
    let sawStructuralVote = false;
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
      sawStructuralVote ||= votes.some((vote) => vote.verdict === 'split');
      try {
        outcome = decideRound(votes, round, { validatorCount, maxRounds: maxVoteRounds });
        if (outcome.decision === 'adjudicate' && sawStructuralVote) {
          outcome = { ...outcome, decision: 'structural_failure' };
        }
      } catch (error) {
        failures.push({ stage: `validate:${candidate.fingerprint}:${round}`, status: 'schema_error', error: error.message });
        outcome = { decision: 'infra_error' };
        break;
      }
      if (outcome.decision !== 'revote') break;
    }

    if (outcome?.decision === 'accept') {
      accepted.push({
        ...candidate,
        level: outcome.level,
        voteSupport: outcome.confirm,
      });
    } else if (outcome?.decision === 'split') {
      pending.push(...splitClusterMembers(candidate));
    } else if (outcome?.decision === 'structural_failure') {
      failures.push({
        stage: `validate:${candidate.fingerprint}:${maxVoteRounds}`,
        status: 'infra_error',
        error: 'validator seats could not resolve whether the consolidated cluster requires independent gates',
      });
    } else if (outcome?.decision === 'adjudicate') {
      const adjudication = await runner.run({
        stage: 'adjudicate', model: REVIEWER_MODEL, candidate, voteRounds,
      });
      if (!stageOk(adjudication)) {
        failures.push(stageFailure(`adjudicate:${candidate.fingerprint}`, adjudication));
      } else if (!validAdjudication(adjudication.data, candidate.fingerprint)) {
        failures.push({
          stage: `adjudicate:${candidate.fingerprint}`,
          status: 'schema_error',
          error: 'adjudication does not match the v2 contract',
        });
      } else if (adjudication.data.decision === 'accept') {
        const lastRound = voteRounds.at(-1) ?? [];
        accepted.push({
          ...candidate,
          level: adjudication.data.level,
          voteSupport: lastRound.filter((vote) => vote.verdict === 'confirm').length,
        });
      }
    }
  }
  return { findings: accepted, failures, coverageGaps };
}
