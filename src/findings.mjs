import { createHash } from 'node:crypto';
import { safeRelativePath } from './diff-sharder.mjs';

const REQUIRED = ['taxonomy', 'path', 'line', 'title', 'evidence', 'rootCause', 'severity'];
const FINDER_FIELDS = ['version', ...REQUIRED].sort();
const SEVERITIES = new Set(['blocker', 'major', 'minor']);
const TAXONOMY_ID = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_FINDER_CANDIDATES = 128;
const MAX_TEXT_LENGTH = Object.freeze({
  taxonomy: 64,
  path: 500,
  title: 180,
  evidence: 6_000,
  rootCause: 2_000,
});

function textLength(value) {
  return [...value].length;
}

function normalizedText(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be a non-empty string`);
  if (MAX_TEXT_LENGTH[name] !== undefined && textLength(value) > MAX_TEXT_LENGTH[name]) {
    throw new TypeError(`${name} must be at most ${MAX_TEXT_LENGTH[name]} characters`);
  }
  return value.trim().replace(/\s+/g, ' ');
}

export function canonicalizeFinding(finding) {
  if (!finding || typeof finding !== 'object' || Array.isArray(finding)) throw new TypeError('finding must be an object');
  for (const key of REQUIRED) {
    if (!(key in finding)) throw new TypeError(`finding is missing ${key}`);
  }
  if (!Number.isInteger(finding.line) || finding.line < 1) throw new TypeError('line must be a positive integer');

  const canonicalPath = safeRelativePath(normalizedText(finding.path, 'path').replaceAll('\\', '/'));
  const severity = normalizedText(finding.severity, 'severity').toLowerCase();
  if (!SEVERITIES.has(severity)) throw new TypeError('severity must be blocker, major, or minor');
  const canonical = {
    taxonomy: normalizedText(finding.taxonomy, 'taxonomy').toLowerCase(),
    path: canonicalPath,
    line: finding.line,
    title: normalizedText(finding.title, 'title'),
    evidence: normalizedText(finding.evidence, 'evidence'),
    rootCause: normalizedText(finding.rootCause, 'rootCause').toLowerCase(),
    severity,
  };
  return canonical;
}

export function canonicalizeFinderCandidate(candidate, assignedTaxonomy) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new TypeError('finding must be an object');
  }
  const fields = Object.keys(candidate).sort();
  if (fields.length !== FINDER_FIELDS.length || fields.some((field, index) => field !== FINDER_FIELDS[index])) {
    const missing = FINDER_FIELDS.find((field) => !fields.includes(field));
    if (missing === 'taxonomy') throw new TypeError('finding is missing taxonomy');
    if (missing) throw new TypeError(`finding is missing ${missing}`);
    throw new TypeError('finder candidate fields do not match the v1 contract');
  }
  if (candidate.version !== 'v1') throw new TypeError('finding version must be "v1"');
  const dimensionId = typeof assignedTaxonomy === 'string' ? assignedTaxonomy : assignedTaxonomy?.id;
  if (typeof dimensionId !== 'string' || !TAXONOMY_ID.test(dimensionId)) throw new TypeError('assigned taxonomy id is required');
  if (candidate.taxonomy !== dimensionId) {
    throw new TypeError(`candidate taxonomy must exactly equal assigned dimension "${dimensionId}"`);
  }
  if (!TAXONOMY_ID.test(candidate.taxonomy)) throw new TypeError('taxonomy must be a canonical dimension id');
  if (!SEVERITIES.has(candidate.severity)) throw new TypeError('severity must be blocker, major, or minor');
  return canonicalizeFinding(candidate);
}

export function canonicalizeFinderCandidates(candidates, assignedTaxonomy) {
  if (!Array.isArray(candidates)) throw new TypeError('finder data must be an array');
  if (candidates.length > MAX_FINDER_CANDIDATES) {
    throw new TypeError(`finder data must contain at most ${MAX_FINDER_CANDIDATES} candidates`);
  }
  return candidates.map((candidate, index) => {
    try {
      return canonicalizeFinderCandidate(candidate, assignedTaxonomy);
    } catch (error) {
      throw new TypeError(`candidate-${index}: ${error.message}`);
    }
  });
}

export function fingerprintFinding(finding) {
  const canonical = canonicalizeFinding(finding);
  const identity = {
    taxonomy: canonical.taxonomy,
    path: canonical.path,
    line: canonical.line,
    rootCause: canonical.rootCause,
  };
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

export function dedupeFindings(findings) {
  if (!Array.isArray(findings)) throw new TypeError('findings must be an array');
  const unique = new Map();
  for (const finding of findings) {
    const canonical = canonicalizeFinding(finding);
    const fingerprint = fingerprintFinding(canonical);
    const existing = unique.get(fingerprint);
    if (existing) {
      existing.provenance.push(finding);
      continue;
    }
    unique.set(fingerprint, { ...canonical, fingerprint, provenance: [finding] });
  }
  return [...unique.values()].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
}
