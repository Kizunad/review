import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createManifest } from '../src/artifact-manifest.mjs';

const schemasDirectory = path.resolve('schemas');

test('all review schemas are strict JSON Schema containers', async () => {
  const files = (await readdir(schemasDirectory)).sort();
  assert.equal(files.length, 9);
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

test('artifact manifest schema matches the implementation contract', async () => {
  const schema = JSON.parse(await readFile(path.join(schemasDirectory, 'artifact-manifest.schema.json'), 'utf8'));
  const manifest = createManifest({
    context: { repository: 'org/repo', pullNumber: 4, baseOid: 'a'.repeat(40), headOid: 'b'.repeat(40) },
    runId: 88,
    workflowRef: 'c'.repeat(40),
    reviewOid: 'b'.repeat(40),
    artifacts: { 'review.json': '{"decision":"approve"}', 'review.md': 'Approved.\n' },
  });
  assert.deepEqual(Object.keys(manifest).sort(), schema.required.slice().sort());
  assert.equal(schema.properties.version.const, manifest.version);
  for (const key of ['workflowRef', 'baseOid', 'headOid', 'reviewOid', 'manifestSha256']) {
    assert.match(manifest[key], new RegExp(schema.properties[key].pattern));
  }
  for (const [file, hash] of Object.entries(manifest.artifacts)) {
    assert.match(hash, new RegExp(schema.properties.artifacts.properties[file].pattern));
  }
});

test('validator and adjudication schemas constrain their decisions', async () => {
  const vote = JSON.parse(await readFile(path.join(schemasDirectory, 'validator-vote.schema.json'), 'utf8'));
  const adjudication = JSON.parse(await readFile(path.join(schemasDirectory, 'adjudication.schema.json'), 'utf8'));
  assert.deepEqual(vote.properties.verdict.enum, ['confirm', 'reject']);
  assert.deepEqual(adjudication.properties.decision.enum, ['accept', 'reject']);
});
