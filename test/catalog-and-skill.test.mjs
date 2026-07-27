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

test('defect-first skill and taxonomy separate proven failures from suggestions', async () => {
  const skill = await read('.claude/skills/code-review/SKILL.md');
  const catalog = JSON.parse(await read('catalog/review-dimensions.v1.json'));
  const testing = catalog.dimensions.find((dimension) => dimension.id === 'testing').prompt;
  const maintainability = catalog.dimensions.find((dimension) => dimension.id === 'strict-maintainability').prompt;

  assert.match(skill, /^---\nname: code-review\n/);
  assert.match(skill, /disable-model-invocation: true/);
  assert.match(skill, /conservation loss/);
  assert.match(skill, /factual documentation defect/);
  assert.match(skill, /specific incorrect implementation/);
  assert.match(skill, /no demonstrated wrong result/);
  assert.match(skill, /Report one root cause once/);
  assert.doesNotMatch(skill, /presumptive blockers?/i);
  assert.doesNotMatch(skill, /Do not approve merely because behavior seems correct/i);
  assert.doesNotMatch(skill, /code judo/i);

  assert.match(testing, /concrete incorrect implementation would still pass/);
  assert.match(testing, /falsely claims coverage/);
  assert.match(testing, /finer assertions.*suggestion/);
  assert.match(maintainability, /non-atomic state/);
  assert.match(maintainability, /without a demonstrated wrong result are suggestions/);
  assert.match(maintainability, /never automatic blockers or majors/);
  assert.doesNotMatch(maintainability, /1000 lines/);
});
