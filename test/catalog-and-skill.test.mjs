import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

async function read(relative) {
  return readFile(new URL(relative, root), 'utf8');
}

test('review taxonomy is versioned, unique, and keeps project policy separate', async () => {
  const catalog = JSON.parse(await read('catalog/review-dimensions.v1.json'));
  assert.equal(catalog.version, 'review-dimensions.v1');
  assert.equal(catalog.dimensions.length, 8);
  const ids = catalog.dimensions.map((dimension) => dimension.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids, [
    'correctness',
    'wiring',
    'schema-contracts',
    'security',
    'concurrency-atomicity',
    'performance',
    'testing',
    'strict-maintainability',
  ]);
  for (const dimension of catalog.dimensions) {
    assert.match(dimension.id, /^[a-z][a-z0-9-]*$/);
    assert.equal(typeof dimension.title, 'string');
    assert.ok(dimension.title.length > 0);
    assert.equal(typeof dimension.prompt, 'string');
    assert.ok(dimension.prompt.length >= 80);
  }
  assert.equal(JSON.stringify(catalog).includes('Bong'), false);
});

test('strict code-review skill remains explicitly invoked and pins structural blockers', async () => {
  const skill = await read('.claude/skills/code-review/SKILL.md');
  assert.match(skill, /^---\nname: code-review\n/);
  assert.match(skill, /disable-model-invocation: true/);
  assert.match(skill, /code judo/i);
  assert.match(skill, /below 1000 lines to above 1000 lines/);
  assert.match(skill, /spaghetti-growth/);
  assert.match(skill, /canonical[- ]helper/i);
  assert.match(skill, /non-atomic updates/);
});
