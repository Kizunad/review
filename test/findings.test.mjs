import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalizeFinderCandidate,
  canonicalizeFinderCandidates,
  canonicalizeFinding,
  consolidateFindings,
  dedupeFindings,
  fingerprintFinding,
  MAX_CONSOLIDATION_CANDIDATES,
} from '../src/findings.mjs';

const finding = {
  taxonomy: 'Security', path: 'src\\handler.mjs', line: 12, level: 'major',
  title: '  Missing authorization ', evidence: ' caller can invoke it ', rootCause: ' Missing   guard ',
};

const finderCandidate = {
  version: 'v2', taxonomy: 'security', path: 'src/handler.mjs', line: 12, level: 'major',
  title: 'Missing authorization', evidence: 'caller can invoke it', rootCause: 'missing guard',
};

function exactCandidates(...overrides) {
  return dedupeFindings(overrides.map((override) => ({ ...finding, ...override })));
}

function singleton(candidate) {
  return {
    representativeFingerprint: candidate.fingerprint,
    memberFingerprints: [candidate.fingerprint],
  };
}

test('canonicalizes v2 findings and fingerprints semantic identity', () => {
  const canonical = canonicalizeFinding(finding);
  assert.deepEqual(canonical, {
    taxonomy: 'security',
    path: 'src/handler.mjs',
    line: 12,
    title: 'Missing authorization',
    evidence: 'caller can invoke it',
    rootCause: 'missing guard',
    level: 'major',
  });
  assert.match(fingerprintFinding(finding), /^[a-f0-9]{64}$/);
  for (const alias of [
    'src/handler.mjs',
    './src/handler.mjs',
    'src/./handler.mjs',
    'src//handler.mjs',
    'src\\handler.mjs',
  ]) {
    assert.equal(fingerprintFinding({ ...finding, path: alias }), fingerprintFinding(finding));
  }

  for (const override of [
    { taxonomy: 'correctness' },
    { level: 'suggestion' },
    { title: 'Different wording' },
    { evidence: 'Different evidence' },
  ]) {
    assert.equal(fingerprintFinding({ ...finding, ...override }), fingerprintFinding(finding));
  }
  for (const override of [
    { path: 'src/other.mjs' },
    { line: 13 },
    { rootCause: 'different guard' },
  ]) {
    assert.notEqual(fingerprintFinding({ ...finding, ...override }), fingerprintFinding(finding));
  }
});

test('deduplicates cross-taxonomy and cross-level exact identities with provenance', () => {
  const duplicate = {
    ...finding,
    taxonomy: 'correctness',
    level: 'suggestion',
    title: 'Different wording',
    evidence: 'Different evidence',
  };
  const unique = dedupeFindings([finding, duplicate, { ...finding, line: 13 }]);
  assert.equal(unique.length, 2);
  const merged = unique.find((entry) => entry.line === 12);
  assert.equal(merged.taxonomy, 'security');
  assert.equal(merged.level, 'major');
  assert.deepEqual(merged.provenance.map(({ taxonomy, level }) => ({ taxonomy, level })), [
    { taxonomy: 'security', level: 'major' },
    { taxonomy: 'correctness', level: 'suggestion' },
  ]);
});

test('deduplicates path aliases before consolidation', () => {
  const aliases = dedupeFindings([
    { ...finding, path: 'src/handler.mjs' },
    { ...finding, path: './src/handler.mjs', taxonomy: 'correctness' },
    { ...finding, path: 'src/./handler.mjs', taxonomy: 'testing' },
  ]);
  assert.equal(aliases.length, 1);
  assert.equal(aliases[0].path, 'src/handler.mjs');
  assert.equal(aliases[0].provenance.length, 3);
});

test('rejects malformed findings and bounds finder arrays', () => {
  assert.throws(() => canonicalizeFinding({}), /missing/);
  assert.throws(() => canonicalizeFinding({ ...finding, line: 0 }), /positive/);
  assert.throws(() => canonicalizeFinding({ ...finding, level: 'critical' }), /level/);
  assert.throws(() => canonicalizeFinding({ ...finding, taxonomy: 'bad taxonomy' }), /canonical dimension id/);
  assert.throws(() => canonicalizeFinding({ ...finding, path: '../escape.mjs' }), /unsafe/);
  assert.throws(
    () => canonicalizeFinderCandidates(Array.from({ length: 129 }, () => finderCandidate), 'security'),
    /at most 128/,
  );
});

test('binds finder candidates to the exact assigned taxonomy', () => {
  assert.deepEqual(canonicalizeFinderCandidate(finderCandidate, 'security'), canonicalizeFinding(finderCandidate));
  assert.deepEqual(canonicalizeFinderCandidate(finderCandidate, { id: 'security' }), canonicalizeFinding(finderCandidate));
  for (const taxonomy of ['correctness', 'Security', 'security ', 'Security and trust boundaries']) {
    assert.throws(
      () => canonicalizeFinderCandidate({ ...finderCandidate, taxonomy }, 'security'),
      /candidate taxonomy must exactly equal assigned dimension "security"/,
    );
  }
});

test('rejects v1, legacy severity, partial, and extra finder envelopes', () => {
  const missingTaxonomy = { ...finderCandidate };
  delete missingTaxonomy.taxonomy;
  assert.throws(() => canonicalizeFinderCandidate(missingTaxonomy, 'security'), /finding is missing taxonomy/);
  assert.throws(() => canonicalizeFinderCandidate({ ...finderCandidate, version: 'v1' }, 'security'), /version must be "v2"/);
  const legacy = { ...finderCandidate, version: 'v1', severity: finderCandidate.level };
  delete legacy.level;
  assert.throws(() => canonicalizeFinderCandidate(legacy, 'security'), /missing level|fields do not match/);
  assert.throws(() => canonicalizeFinderCandidate({ ...finderCandidate, extra: true }, 'security'), /fields do not match/);
  assert.throws(() => canonicalizeFinderCandidate({ ...finderCandidate, level: 'Major' }, 'security'), /level/);
  assert.throws(() => canonicalizeFinderCandidate(finderCandidate, {}), /assigned taxonomy id is required/);
});

test('consolidates same-path semantic variants without rewriting or dropping validation members', () => {
  const candidates = exactCandidates(
    { taxonomy: 'security', title: 'First root cause', rootCause: 'unguarded write', line: 10 },
    { taxonomy: 'correctness', title: 'Same defect elsewhere', rootCause: 'missing authorization', line: 11 },
    { taxonomy: 'testing', title: 'Independent defect', rootCause: 'missing regression', line: 40 },
  );
  const members = candidates.filter((candidate) => candidate.line < 40);
  const separate = candidates.find((candidate) => candidate.line === 40);
  const representative = members[1];
  const consolidated = consolidateFindings(candidates, {
    version: 'v2',
    clusters: [
      {
        representativeFingerprint: representative.fingerprint,
        memberFingerprints: members.map((candidate) => candidate.fingerprint),
      },
      singleton(separate),
    ],
  });
  assert.equal(consolidated.length, 2);
  const merged = consolidated.find((candidate) => candidate.memberFingerprints.length === 2);
  assert.equal(merged.fingerprint, representative.fingerprint);
  assert.equal(merged.title, representative.title);
  assert.deepEqual(merged.memberFingerprints, members.map((candidate) => candidate.fingerprint));
  assert.equal(merged.provenance.length, 2);
  assert.deepEqual(
    merged.validationCandidates.map((candidate) => candidate.rootCause),
    ['missing authorization', 'unguarded write'],
  );
});

test('consolidation rejects missing, duplicate, unknown, and invalid representatives', () => {
  const candidates = exactCandidates(
    { rootCause: 'first cause', line: 10 },
    { rootCause: 'second cause', line: 11 },
  );
  const [first, second] = candidates;
  const unknown = 'f'.repeat(64) === first.fingerprint ? 'e'.repeat(64) : 'f'.repeat(64);

  assert.throws(
    () => consolidateFindings(candidates, { version: 'v2', clusters: [singleton(first)] }),
    /omitted member/,
  );
  assert.throws(
    () => consolidateFindings(candidates, {
      version: 'v2',
      clusters: [
        { representativeFingerprint: first.fingerprint, memberFingerprints: [first.fingerprint, first.fingerprint] },
        singleton(second),
      ],
    }),
    /duplicate member/,
  );
  assert.throws(
    () => consolidateFindings(candidates, {
      version: 'v2',
      clusters: [singleton(first), singleton(first), singleton(second)],
    }),
    /multiple clusters/,
  );
  assert.throws(
    () => consolidateFindings(candidates, {
      version: 'v2',
      clusters: [
        { representativeFingerprint: unknown, memberFingerprints: [unknown] },
        singleton(first),
        singleton(second),
      ],
    }),
    /unknown member/,
  );
  assert.throws(
    () => consolidateFindings(candidates, {
      version: 'v2',
      clusters: [{ representativeFingerprint: second.fingerprint, memberFingerprints: [first.fingerprint] }, singleton(second)],
    }),
    /representative must be one of its members/,
  );
});

test('consolidation rejects cross-path clusters and all malformed bounds', () => {
  const candidates = exactCandidates(
    { path: 'src/first.mjs', rootCause: 'same cause', line: 10 },
    { path: 'src/second.mjs', rootCause: 'same cause', line: 10 },
  );
  const [first, second] = candidates;
  const merged = {
    representativeFingerprint: first.fingerprint,
    memberFingerprints: [first.fingerprint, second.fingerprint],
  };
  assert.throws(
    () => consolidateFindings(candidates, { version: 'v2', clusters: [merged] }),
    /different paths/,
  );
  assert.throws(() => consolidateFindings([], { version: 'v2', clusters: [] }), /non-empty array/);
  assert.throws(
    () => consolidateFindings(Array(MAX_CONSOLIDATION_CANDIDATES + 1).fill(first), { version: 'v2', clusters: [singleton(first)] }),
    /at most 128/,
  );
  assert.throws(() => consolidateFindings(candidates, { version: 'v1', clusters: [singleton(first), singleton(second)] }), /version must be "v2"/);
  assert.throws(() => consolidateFindings(candidates, { version: 'v2', clusters: [] }), /between 1 and 128/);
  assert.throws(
    () => consolidateFindings(candidates, { version: 'v2', clusters: Array(129).fill(singleton(first)) }),
    /between 1 and 128/,
  );
  assert.throws(
    () => consolidateFindings(candidates, { version: 'v2', clusters: [singleton(first), singleton(second)], extra: true }),
    /fields do not match/,
  );
  assert.throws(
    () => consolidateFindings(candidates, {
      version: 'v2',
      clusters: [{ ...singleton(first), extra: true }, singleton(second)],
    }),
    /fields do not match/,
  );
  assert.throws(
    () => consolidateFindings(candidates, {
      version: 'v2',
      clusters: [{ representativeFingerprint: first.fingerprint, memberFingerprints: [] }, singleton(second)],
    }),
    /cardinality/,
  );
  assert.throws(
    () => consolidateFindings([{ ...first, fingerprint: 'bad' }], { version: 'v2', clusters: [singleton(first)] }),
    /fingerprint is invalid/,
  );
});
