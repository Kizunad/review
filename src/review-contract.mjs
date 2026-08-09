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

// Bounds on how much of an unexpected key set is quoted back, mirroring the #36 finder fix.
// A drifted output carries a key or two; anything longer is the model pasting diff content
// into a field name, which is exactly the case that must not reach the prompt intact.
const MAX_REPORTED_FIELDS = 8;
const MAX_REPORTED_FIELD_CHARS = 64;

// The vote failure message is echoed verbatim into the repair prompt ("Your previous output
// failed schema validation: <error>"), so every value and key observed on the wire is
// untrusted model output - and the model's input is the PR diff, a repository this engine
// does not control. JSON.stringify escapes control characters and quotes; the length cap
// stops a pathological value from filling the prompt. A valid 64-hex fingerprint renders
// fully within the cap. The cap must bind the VALUE before encoding: serializing a giant
// string and then clipping it still pays the full serialization, so describeUntrustedValue
// clips content first and reduces objects/arrays to a structural summary.
const MAX_REPORTED_VALUE_CHARS = 96;

function clipChars(value, maxChars) {
  const chars = [...value];
  return chars.length <= maxChars ? value : chars.slice(0, maxChars).join('');
}

function describeUntrustedValue(value) {
  if (value === null) return 'null';
  const kind = typeof value;
  if (kind === 'string') {
    const chars = [...value];
    if (chars.length <= MAX_REPORTED_VALUE_CHARS) return JSON.stringify(value);
    return `${JSON.stringify(clipChars(value, MAX_REPORTED_VALUE_CHARS))}… (+${chars.length - MAX_REPORTED_VALUE_CHARS} more chars)`;
  }
  if (kind === 'number' || kind === 'boolean') return String(value);
  if (Array.isArray(value)) return `array(${value.length})`;
  if (kind === 'object') {
    const keys = Object.keys(value);
    const head = keys.slice(0, MAX_REPORTED_FIELDS)
      .map((key) => JSON.stringify(clipChars(key, MAX_REPORTED_FIELD_CHARS)))
      .join(', ');
    const omitted = keys.length - Math.min(keys.length, MAX_REPORTED_FIELDS);
    return `object{${clipChars(head, MAX_REPORTED_VALUE_CHARS)}}${omitted > 0 ? ` (+${omitted} more)` : ''}`;
  }
  return kind;
}

function describeUntrustedFields(fields) {
  const shown = fields.slice(0, MAX_REPORTED_FIELDS).map((field) => {
    const chars = [...field];
    const clipped = chars.slice(0, MAX_REPORTED_FIELD_CHARS).join('');
    return JSON.stringify(clipped) + (chars.length > MAX_REPORTED_FIELD_CHARS ? '(truncated)' : '');
  });
  const omitted = fields.length - shown.length;
  return omitted > 0 ? `${shown.join(', ')}, +${omitted} more` : shown.join(', ');
}

// Content of the evidence/reason fields is never echoed (it can be arbitrarily large and is
// the least useful part of a failure); report the type or length instead.
function describeText(value) {
  if (typeof value !== 'string') return `as a ${value === null ? 'null' : typeof value} value`;
  return `of ${[...value].length} characters`;
}

// The observed verdict/reachable/level are recorded on EVERY failure, not just the coupling
// one. With only the condition, a reader learns which rule tripped but not why - and the two
// fatal shapes are only distinguishable by their values: verdict=reject with a real level is
// the reject/level coupling; a confirm vote failing on candidateFingerprint is echoing a
// MEMBER fingerprint instead of the cluster's.
function observedVote(data) {
  return `; observed verdict=${describeUntrustedValue(data.verdict)}, reachable=${describeUntrustedValue(data.reachable)}, level=${describeUntrustedValue(data.level)}`;
}

// The vote gate's failure message is the repair prompt's only content: claude-runner echoes
// it back verbatim as "Your previous output failed schema validation: <error>". isCountableVote
// collapses ten independent conditions into one boolean, so validateStage could only report
// the field SHAPE - and a vote that broke a VALUE condition (bad fingerprint, forbidden level,
// broken reachable/verdict coupling) was told its fields were wrong while they were exactly
// right, so the model re-emitted a near-identical vote and burned the whole repair budget.
// This names the condition that broke, in the same order as the boolean chain, plus the
// observed verdict/reachable/level, so the repair loop can actually converge.
//
// Returns null when the vote IS countable - the boolean projection of this function is
// isCountableVote, so the two can never drift apart.
export function describeCountableVoteFailure(data, candidateFingerprint) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return 'is not an object';
  }
  const actual = Object.keys(data).sort();
  const expected = VOTE_FIELDS;
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    const missing = expected.filter((field) => !actual.includes(field));
    const unexpected = actual.filter((field) => !expected.includes(field));
    return 'has the wrong field set: expected exactly '
      + expected.join(', ')
      + (missing.length ? `; missing ${missing.join(', ')}` : '')
      + (unexpected.length ? `; unexpected ${describeUntrustedFields(unexpected)}` : '')
      + observedVote(data);
  }
  if (data.version !== 'v2') {
    return `has version ${describeUntrustedValue(data.version)}; must be "v2"` + observedVote(data);
  }
  if (!FINGERPRINT.test(data.candidateFingerprint)) {
    return `has a malformed candidateFingerprint ${describeUntrustedValue(data.candidateFingerprint)}; must be 64 lowercase hex characters` + observedVote(data);
  }
  if (candidateFingerprint !== undefined && data.candidateFingerprint !== candidateFingerprint) {
    return `has candidateFingerprint ${describeUntrustedValue(data.candidateFingerprint)} that does not equal the supplied cluster fingerprint ${describeUntrustedValue(candidateFingerprint)}` + observedVote(data);
  }
  if (data.verdict !== 'confirm' && data.verdict !== 'reject' && data.verdict !== 'split') {
    return `has verdict ${describeUntrustedValue(data.verdict)}; must be "confirm", "reject", or "split"` + observedVote(data);
  }
  if (typeof data.reachable !== 'boolean') {
    return `has non-boolean reachable ${describeUntrustedValue(data.reachable)}` + observedVote(data);
  }
  if (!LEVELS.has(data.level)) {
    return `has unknown level ${describeUntrustedValue(data.level)}; must be one of ${REVIEW_LEVELS.join(', ')}` + observedVote(data);
  }
  if (data.verdict === 'confirm' ? data.reachable !== true : !(data.reachable === false && data.level === 'suggestion')) {
    const rule = data.verdict === 'confirm'
      ? 'confirm requires reachable=true'
      : 'reject and split require reachable=false and level "suggestion"';
    return `violates the reachable/level coupling: ${rule}` + observedVote(data);
  }
  if (!boundedText(data.evidence, 4_000)) {
    return `has evidence ${describeText(data.evidence)}; must be a 1-to-4000-character string` + observedVote(data);
  }
  if (!boundedText(data.reason, 4_000)) {
    return `has reason ${describeText(data.reason)}; must be a 1-to-4000-character string` + observedVote(data);
  }
  return null;
}

export function isCountableVote(data, candidateFingerprint) {
  return describeCountableVoteFailure(data, candidateFingerprint) === null;
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
