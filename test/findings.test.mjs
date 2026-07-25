import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeFinding, dedupeFindings, fingerprintFinding } from '../src/findings.mjs';

const finding = {
  taxonomy: 'Security', path: 'src\\handler.mjs', line: 12, severity: 'major',
  title: '  Missing authorization ', evidence: ' caller can invoke it ', rootCause: ' Missing   guard ',
};

test('canonicalizes findings and fingerprints semantic identity', () => {
  const canonical = canonicalizeFinding(finding);
  assert.equal(canonical.path, 'src/handler.mjs');
  assert.equal(canonical.rootCause, 'missing guard');
  assert.match(fingerprintFinding(finding), /^[a-f0-9]{64}$/);
});

test('deduplicates same taxonomy location and root cause with provenance', () => {
  const duplicate = { ...finding, title: 'Different wording', evidence: 'Different evidence' };
  const unique = dedupeFindings([finding, duplicate, { ...finding, line: 13 }]);
  assert.equal(unique.length, 2);
  assert.equal(unique.find((entry) => entry.line === 12).provenance.length, 2);
});

test('rejects malformed findings', () => {
  assert.throws(() => canonicalizeFinding({}), /missing/);
  assert.throws(() => canonicalizeFinding({ ...finding, line: 0 }), /positive/);
  assert.throws(() => canonicalizeFinding({ ...finding, severity: 'critical' }), /severity/);
  assert.throws(() => canonicalizeFinding({ ...finding, path: '../escape.mjs' }), /unsafe/);
});
