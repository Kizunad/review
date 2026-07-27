import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createManifest } from '../src/artifact-manifest.mjs';
import {
  MAX_PUBLIC_FAILURES,
  MAX_PUBLIC_FINDINGS,
  MAX_PUBLIC_SUGGESTIONS,
  PUBLIC_FAILURE_TEXT_LIMITS,
  PUBLIC_FINDING_TEXT_LIMITS,
} from '../src/review-entry.mjs';

const schemasDirectory = path.resolve('schemas');

test('all review schemas are strict JSON Schema containers', async () => {
  const files = (await readdir(schemasDirectory)).sort();
  assert.equal(files.length, 10);
  for (const file of files) {
    const schema = JSON.parse(await readFile(path.join(schemasDirectory, file), 'utf8'));
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.ok(schema.type === 'object' || schema.type === 'array', `${file} is an object or array schema`);
    if (schema.type === 'object') {
      assert.equal(schema.additionalProperties, false);
      assert.ok(Array.isArray(schema.required) && schema.required.length > 0, `${file} requires fields`);
    } else {
      assert.ok(Number.isInteger(schema.maxItems), `${file} bounds array output`);
      assert.equal(schema.items.type, 'object');
      assert.equal(schema.items.additionalProperties, false);
    }
  }
});

test('final review failures allow only bounded optional diagnostics', async () => {
  const schema = JSON.parse(await readFile(path.join(schemasDirectory, 'final-review.schema.json'), 'utf8'));
  const failure = schema.properties.failures.items;

  assert.equal(failure.additionalProperties, false);
  assert.deepEqual(failure.required, ['stage', 'status', 'error']);
  assert.deepEqual(failure.properties.diagnostic, {
    type: 'string',
    minLength: 1,
    maxLength: 4000,
  });
});

test('artifact manifest schema matches the implementation contract', async () => {
  const schema = JSON.parse(await readFile(path.join(schemasDirectory, 'artifact-manifest.schema.json'), 'utf8'));
  const manifest = createManifest({
    context: { repository: 'org/repo', pullNumber: 4, baseOid: 'a'.repeat(40), headOid: 'b'.repeat(40) },
    runId: 88,
    runAttempt: 1,
    workflowRef: 'c'.repeat(40),
    reviewOid: 'b'.repeat(40),
    policySha256: 'd'.repeat(64),
    artifacts: { 'review.json': '{"decision":"approve"}', 'review.md': 'Approved.\n' },
  });
  assert.deepEqual(Object.keys(manifest).sort(), schema.required.slice().sort());
  assert.equal(schema.properties.version.const, manifest.version);
  for (const key of ['workflowRef', 'baseOid', 'headOid', 'reviewOid', 'policySha256', 'manifestSha256']) {
    assert.match(manifest[key], new RegExp(schema.properties[key].pattern));
  }
  for (const [file, hash] of Object.entries(manifest.artifacts)) {
    assert.match(hash, new RegExp(schema.properties.artifacts.properties[file].pattern));
  }
});

test('v2 schemas separate validated defects from bounded suggestions', async () => {
  const candidates = JSON.parse(await readFile(path.join(schemasDirectory, 'finding-candidates.schema.json'), 'utf8'));
  const consolidation = JSON.parse(await readFile(path.join(schemasDirectory, 'consolidation.schema.json'), 'utf8'));
  const review = JSON.parse(await readFile(path.join(schemasDirectory, 'final-review.schema.json'), 'utf8'));

  assert.equal(candidates.items.properties.version.const, 'v2');
  assert.equal('severity' in candidates.items.properties, false);
  assert.deepEqual(candidates.items.properties.level.enum, ['blocker', 'major', 'minor', 'suggestion']);
  assert.equal(consolidation.properties.version.const, 'v2');
  assert.equal(consolidation.properties.clusters.maxItems, 128);
  assert.equal(consolidation.properties.clusters.items.properties.memberFingerprints.uniqueItems, true);
  assert.deepEqual(review.required, [
    'version',
    'decision',
    'findings',
    'suggestions',
    'omittedSuggestions',
    'failures',
  ]);
  assert.equal(review.properties.version.const, 'v2');
  assert.equal(review.properties.findings.maxItems, MAX_PUBLIC_FINDINGS);
  assert.deepEqual(review.properties.findings.items.properties.level.enum, ['blocker', 'major', 'minor']);
  assert.equal(review.properties.suggestions.maxItems, MAX_PUBLIC_SUGGESTIONS);
  assert.equal(review.properties.suggestions.items.properties.level.const, 'suggestion');
  assert.equal(review.properties.failures.maxItems, MAX_PUBLIC_FAILURES);
  for (const property of ['taxonomy', 'path', 'title', 'evidence', 'rootCause']) {
    const itemProperty = review.properties.findings.items.properties[property];
    const suggestionProperty = review.properties.suggestions.items.properties[property];
    if (property === 'taxonomy') {
      const bound = PUBLIC_FINDING_TEXT_LIMITS.taxonomy - 1;
      assert.equal(itemProperty.pattern, `^[a-z][a-z0-9-]{0,${bound}}$`);
      assert.equal(suggestionProperty.pattern, itemProperty.pattern);
    } else {
      assert.equal(itemProperty.maxLength, PUBLIC_FINDING_TEXT_LIMITS[property]);
      assert.equal(suggestionProperty.maxLength, PUBLIC_FINDING_TEXT_LIMITS[property]);
    }
  }
  for (const property of ['stage', 'error', 'diagnostic']) {
    assert.equal(
      review.properties.failures.items.properties[property].maxLength,
      PUBLIC_FAILURE_TEXT_LIMITS[property],
    );
  }
  assert.equal(review.properties.omittedSuggestions.minimum, 0);
});

test('final review schema locks decision and content semantics', async () => {
  const schema = JSON.parse(await readFile(path.join(schemasDirectory, 'final-review.schema.json'), 'utf8'));
  const obeysProperties = (review, properties) => Object.entries(properties ?? {})
    .every(([property, rule]) => {
      const value = review[property];
      if ('const' in rule && value !== rule.const) return false;
      if ('minItems' in rule && value.length < rule.minItems) return false;
      if ('maxItems' in rule && value.length > rule.maxItems) return false;
      const requiredLevel = rule.items?.properties?.level?.const;
      return requiredLevel === undefined || value.every((item) => item.level === requiredLevel);
    });
  const obeysConditional = (review, conditional) => {
    const matches = Object.entries(conditional.if.properties)
      .every(([property, rule]) => review[property] === rule.const);
    const branch = matches ? conditional.then : conditional.else;
    if (!branch) return true;
    if (!obeysProperties(review, branch.properties)) return false;
    if (!branch.if) return true;
    const nestedMatches = Object.entries(branch.if.properties)
      .every(([property, rule]) => review[property] === rule.const);
    const nestedBranch = nestedMatches ? branch.then : branch.else;
    return !nestedBranch || obeysProperties(review, nestedBranch.properties);
  };
  const acceptsDecisionContract = (review) => schema.allOf
    .every((conditional) => obeysConditional(review, conditional));
  const base = {
    version: 'v2',
    decision: 'approve',
    findings: [],
    suggestions: [],
    omittedSuggestions: 0,
    failures: [],
  };
  const major = { level: 'major' };
  const minor = { level: 'minor' };
  const suggestion = { level: 'suggestion' };
  const failure = { status: 'infra_error' };

  assert.equal(acceptsDecisionContract(base), true);
  assert.equal(acceptsDecisionContract({ ...base, findings: [minor] }), true);
  assert.equal(acceptsDecisionContract({ ...base, findings: [major] }), false);
  assert.equal(acceptsDecisionContract({ ...base, decision: 'request_changes', findings: [major] }), true);
  assert.equal(acceptsDecisionContract({ ...base, decision: 'request_changes' }), false);
  assert.equal(acceptsDecisionContract({ ...base, decision: 'request_changes', failures: [failure] }), false);
  assert.equal(acceptsDecisionContract({
    ...base,
    decision: 'infrastructure_failure',
    failures: [failure],
  }), true);
  assert.equal(acceptsDecisionContract({ ...base, decision: 'infrastructure_failure' }), false);
  assert.equal(acceptsDecisionContract({
    ...base,
    decision: 'infrastructure_failure',
    findings: [minor],
    failures: [failure],
  }), false);
  assert.equal(acceptsDecisionContract({
    ...base,
    decision: 'infrastructure_failure',
    suggestions: [suggestion],
    failures: [failure],
  }), false);
  assert.equal(acceptsDecisionContract({
    ...base,
    decision: 'infrastructure_failure',
    omittedSuggestions: 1,
    failures: [failure],
  }), false);
});

test('validator and adjudication schemas constrain their decisions and levels', async () => {
  const vote = JSON.parse(await readFile(path.join(schemasDirectory, 'validator-vote.schema.json'), 'utf8'));
  const adjudication = JSON.parse(await readFile(path.join(schemasDirectory, 'adjudication.schema.json'), 'utf8'));
  assert.equal(vote.properties.version.const, 'v2');
  assert.deepEqual(vote.properties.verdict.enum, ['confirm', 'reject', 'split']);
  assert.deepEqual(vote.properties.level.enum, ['blocker', 'major', 'minor', 'suggestion']);
  assert.ok(vote.required.includes('level'));
  assert.equal(vote.allOf[0].if.properties.verdict.const, 'confirm');
  assert.equal(vote.allOf[0].then.properties.reachable.const, true);
  assert.equal(vote.allOf[0].else.properties.reachable.const, false);
  assert.equal(vote.allOf[0].else.properties.level.const, 'suggestion');
  assert.equal(adjudication.properties.version.const, 'v2');
  assert.deepEqual(adjudication.properties.decision.enum, ['accept', 'reject']);
  assert.deepEqual(adjudication.properties.level.enum, ['blocker', 'major', 'minor', 'suggestion']);
  assert.deepEqual(adjudication.allOf[0].then.required, ['level']);
  assert.deepEqual(adjudication.allOf[0].else.not.required, ['level']);
});
