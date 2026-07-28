import { REVIEW_LEVELS } from './findings.mjs';

const LEVELS = new Set(REVIEW_LEVELS);
const FINGERPRINT = /^[a-f0-9]{64}$/;
const VOTE_FIELDS = ['version', 'candidateFingerprint', 'verdict', 'reachable', 'level', 'evidence', 'reason'].sort();

function exactFields(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  return actual.length === expected.length
    && actual.every((field, index) => field === expected[index]);
}

function boundedText(value, maxLength) {
  return typeof value === 'string' && [...value].length >= 1 && [...value].length <= maxLength;
}

export function isCountableVote(data, candidateFingerprint) {
  return exactFields(data, VOTE_FIELDS)
    && data.version === 'v2'
    && FINGERPRINT.test(data.candidateFingerprint)
    && (candidateFingerprint === undefined || data.candidateFingerprint === candidateFingerprint)
    && (data.verdict === 'confirm' || data.verdict === 'reject' || data.verdict === 'split')
    && typeof data.reachable === 'boolean'
    && LEVELS.has(data.level)
    && (data.verdict === 'confirm'
      ? data.reachable === true
      : data.reachable === false && data.level === 'suggestion')
    && boundedText(data.evidence, 4_000)
    && boundedText(data.reason, 4_000);
}

export function validAdjudication(data, candidateFingerprint) {
  const fields = data?.decision === 'accept'
    ? ['version', 'candidateFingerprint', 'decision', 'level', 'reason']
    : ['version', 'candidateFingerprint', 'decision', 'reason'];
  return exactFields(data, fields)
    && data.version === 'v2'
    && FINGERPRINT.test(data.candidateFingerprint)
    && data.candidateFingerprint === candidateFingerprint
    && (data.decision === 'accept' || data.decision === 'reject')
    && (data.decision !== 'accept' || LEVELS.has(data.level))
    && boundedText(data.reason, 4_000);
}
