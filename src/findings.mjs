import { createHash } from 'node:crypto';
import { compareStrings } from './deterministic.mjs';
import { safeRelativePath } from './diff-sharder.mjs';
import { PUBLIC_FINDING_TEXT_LIMITS } from './review-limits.mjs';

const REQUIRED = ['taxonomy', 'path', 'line', 'title', 'evidence', 'rootCause', 'level'];
const FINDER_FIELDS = ['version', ...REQUIRED].sort();
export const REVIEW_LEVELS = Object.freeze(['blocker', 'major', 'minor', 'suggestion']);
const LEVELS = new Set(REVIEW_LEVELS);
const TAXONOMY_ID = /^[a-z][a-z0-9-]{0,63}$/;
const FINGERPRINT = /^[a-f0-9]{64}$/;
const MAX_FINDER_CANDIDATES = 128;
export const MAX_CONSOLIDATION_CANDIDATES = 128;

function textLength(value) {
  return [...value].length;
}

function normalizedText(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be a non-empty string`);
  if (PUBLIC_FINDING_TEXT_LIMITS[name] !== undefined && textLength(value) > PUBLIC_FINDING_TEXT_LIMITS[name]) {
    throw new TypeError(`${name} must be at most ${PUBLIC_FINDING_TEXT_LIMITS[name]} characters`);
  }
  return value.trim().replace(/\s+/g, ' ');
}

function exactFields(value, fields, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new TypeError(`${name} fields do not match the v2 contract`);
  }
}

export function canonicalizeFinding(finding) {
  if (!finding || typeof finding !== 'object' || Array.isArray(finding)) throw new TypeError('finding must be an object');
  for (const key of REQUIRED) {
    if (!(key in finding)) throw new TypeError(`finding is missing ${key}`);
  }
  if (!Number.isInteger(finding.line) || finding.line < 1) throw new TypeError('line must be a positive integer');

  const taxonomy = normalizedText(finding.taxonomy, 'taxonomy').toLowerCase();
  if (!TAXONOMY_ID.test(taxonomy)) throw new TypeError('taxonomy must be a canonical dimension id');
  const canonicalPath = safeRelativePath(normalizedText(finding.path, 'path'));
  const level = normalizedText(finding.level, 'level').toLowerCase();
  if (!LEVELS.has(level)) throw new TypeError('level must be blocker, major, minor, or suggestion');
  return {
    taxonomy,
    path: canonicalPath,
    line: finding.line,
    title: normalizedText(finding.title, 'title'),
    evidence: normalizedText(finding.evidence, 'evidence'),
    rootCause: normalizedText(finding.rootCause, 'rootCause').toLowerCase(),
    level,
  };
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
    throw new TypeError('finder candidate fields do not match the v2 contract');
  }
  if (candidate.version !== 'v2') throw new TypeError('finding version must be "v2"');
  const dimensionId = typeof assignedTaxonomy === 'string' ? assignedTaxonomy : assignedTaxonomy?.id;
  if (typeof dimensionId !== 'string' || !TAXONOMY_ID.test(dimensionId)) throw new TypeError('assigned taxonomy id is required');
  if (candidate.taxonomy !== dimensionId) {
    throw new TypeError(`candidate taxonomy must exactly equal assigned dimension "${dimensionId}"`);
  }
  if (!TAXONOMY_ID.test(candidate.taxonomy)) throw new TypeError('taxonomy must be a canonical dimension id');
  if (!LEVELS.has(candidate.level)) throw new TypeError('level must be blocker, major, minor, or suggestion');
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
      existing.provenance.push(canonical);
      continue;
    }
    unique.set(fingerprint, { ...canonical, fingerprint, provenance: [canonical] });
  }
  return [...unique.values()].sort((a, b) => compareStrings(a.fingerprint, b.fingerprint));
}

export function consolidateFindings(findings, consolidation) {
  if (!Array.isArray(findings) || findings.length < 1) throw new TypeError('consolidation findings must be a non-empty array');
  if (findings.length > MAX_CONSOLIDATION_CANDIDATES) {
    throw new TypeError(`consolidation input must contain at most ${MAX_CONSOLIDATION_CANDIDATES} candidates`);
  }
  exactFields(consolidation, ['version', 'clusters'], 'consolidation');
  if (consolidation.version !== 'v2') throw new TypeError('consolidation version must be "v2"');
  if (!Array.isArray(consolidation.clusters) || consolidation.clusters.length < 1
    || consolidation.clusters.length > MAX_CONSOLIDATION_CANDIDATES) {
    throw new TypeError(`consolidation clusters must contain between 1 and ${MAX_CONSOLIDATION_CANDIDATES} entries`);
  }

  const candidates = new Map();
  for (const candidate of findings) {
    if (!candidate || typeof candidate !== 'object' || !FINGERPRINT.test(candidate.fingerprint)) {
      throw new TypeError('consolidation candidate fingerprint is invalid');
    }
    if (candidates.has(candidate.fingerprint)) throw new TypeError('consolidation input contains a duplicate fingerprint');
    candidates.set(candidate.fingerprint, candidate);
  }

  const seen = new Set();
  const merged = consolidation.clusters.map((cluster, clusterIndex) => {
    exactFields(cluster, ['representativeFingerprint', 'memberFingerprints'], `cluster-${clusterIndex}`);
    if (!FINGERPRINT.test(cluster.representativeFingerprint)) {
      throw new TypeError(`cluster-${clusterIndex} representative fingerprint is invalid`);
    }
    if (!Array.isArray(cluster.memberFingerprints) || cluster.memberFingerprints.length < 1
      || cluster.memberFingerprints.length > MAX_CONSOLIDATION_CANDIDATES) {
      throw new TypeError(`cluster-${clusterIndex} member cardinality is invalid`);
    }
    const memberSet = new Set();
    const members = cluster.memberFingerprints.map((fingerprint) => {
      if (!FINGERPRINT.test(fingerprint)) {
        throw new TypeError(`cluster-${clusterIndex} member fingerprint is invalid`);
      }
      if (memberSet.has(fingerprint)) {
        throw new TypeError(`cluster-${clusterIndex} contains a duplicate member`);
      }
      if (seen.has(fingerprint)) {
        throw new TypeError(`consolidation member ${fingerprint} appears in multiple clusters`);
      }
      const candidate = candidates.get(fingerprint);
      if (!candidate) throw new TypeError(`consolidation contains unknown member ${fingerprint}`);
      memberSet.add(fingerprint);
      seen.add(fingerprint);
      return candidate;
    });
    if (!memberSet.has(cluster.representativeFingerprint)) {
      throw new TypeError(`cluster-${clusterIndex} representative must be one of its members`);
    }
    if (new Set(members.map((candidate) => candidate.path)).size !== 1) {
      throw new TypeError(`cluster-${clusterIndex} cannot merge candidates from different paths`);
    }
    const validationCandidates = [...members]
      .sort((left, right) => compareStrings(left.rootCause, right.rootCause)
        || compareStrings(left.fingerprint, right.fingerprint))
      .map((candidate) => ({
        taxonomy: candidate.taxonomy,
        path: candidate.path,
        line: candidate.line,
        title: candidate.title,
        evidence: candidate.evidence,
        rootCause: candidate.rootCause,
        level: candidate.level,
        fingerprint: candidate.fingerprint,
        provenance: candidate.provenance ?? [canonicalizeFinding(candidate)],
      }));
    const representative = candidates.get(cluster.representativeFingerprint);
    return {
      ...representative,
      provenance: members.flatMap((candidate) => candidate.provenance ?? [canonicalizeFinding(candidate)]),
      memberFingerprints: [...memberSet],
      validationCandidates,
    };
  });

  if (seen.size !== candidates.size) {
    const missing = [...candidates.keys()].find((fingerprint) => !seen.has(fingerprint));
    throw new TypeError(`consolidation omitted member ${missing}`);
  }
  return merged.sort((a, b) => compareStrings(a.fingerprint, b.fingerprint));
}
