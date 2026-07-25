import { createHash } from 'node:crypto';
import { safeRelativePath } from './diff-sharder.mjs';

const REQUIRED = ['taxonomy', 'path', 'line', 'title', 'evidence', 'rootCause', 'severity'];
const SEVERITIES = new Set(['blocker', 'major', 'minor']);

function normalizedText(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be a non-empty string`);
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
