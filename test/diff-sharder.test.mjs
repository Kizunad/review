import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { groupShards, resolveInsideRoot, safeRelativePath, shardDiff } from '../src/diff-sharder.mjs';

test('rejects traversal, absolute paths, NUL, and symlink escapes', async () => {
  assert.throws(() => safeRelativePath('../outside'), /unsafe/);
  assert.throws(() => safeRelativePath('/outside'), /unsafe/);
  assert.throws(() => safeRelativePath('bad\0path'), /NUL/);
  const root = await mkdtemp(path.join(tmpdir(), 'diff-root-'));
  await mkdir(path.join(root, 'inside'));
  assert.equal(await resolveInsideRoot(root, 'inside'), path.join(root, 'inside'));
  await symlink(tmpdir(), path.join(root, 'escape'));
  await assert.rejects(resolveInsideRoot(root, 'escape'), /escapes/);
});

test('canonicalizes equivalent relative path aliases', () => {
  for (const candidate of [
    'src/a.mjs',
    './src/a.mjs',
    'src/./a.mjs',
    'src//a.mjs',
    'src\\a.mjs',
  ]) {
    assert.equal(safeRelativePath(candidate), 'src/a.mjs');
  }
  assert.throws(() => safeRelativePath('.'), /unsafe/);
  assert.throws(() => safeRelativePath('./'), /unsafe/);
  assert.throws(() => safeRelativePath('src/../outside'), /unsafe/);
});

test('shards empty, normal, and oversized diffs deterministically at exact boundaries', () => {
  assert.deepEqual(shardDiff(''), []);
  const first = 'diff --git a/a.js b/a.js\n+one\n';
  const second = 'diff --git a/b.js b/b.js\n+two\n';
  const shards = shardDiff(first + second, { maxChars: first.length + 1 });
  assert.equal(shards.length, 2);
  assert.deepEqual(shards.map((entry) => entry.paths), [['a.js'], ['b.js']]);

  const aliases = shardDiff(
    'diff --git a/./src/a.js b/./src/a.js\n+x\n',
    { maxChars: 100 },
  );
  assert.deepEqual(aliases[0].paths, ['src/a.js']);

  const exact = shardDiff('x'.repeat(15), { maxChars: 15 });
  assert.deepEqual(exact.map((entry) => entry.text.length), [15]);
  const over = shardDiff('x'.repeat(16), { maxChars: 15 });
  assert.deepEqual(over.map((entry) => entry.text.length), [15, 1]);

  const large = `diff --git a/large.js b/large.js\n${'+x'.repeat(20)}`;
  const split = shardDiff(large, { maxChars: 15 });
  assert.ok(split.length > 1);
  assert.ok(split.every((entry) => entry.text.length <= 15));
  assert.ok(split.every((entry) => entry.paths[0] === 'large.js'));
  assert.equal(split.map((entry) => entry.text).join(''), large);
});

test('groups complete shard sets without exceeding the downstream prompt budget', () => {
  const shards = [
    { index: 0, text: '1234', paths: ['a.js'] },
    { index: 1, text: '56', paths: ['a.js', 'b.js'] },
    { index: 2, text: '7890', paths: ['c.js'] },
  ];
  const groups = groupShards(shards, { maxChars: 6 });
  assert.deepEqual(groups, [
    { index: 0, shardIndexes: [0, 1], text: '123456', paths: ['a.js', 'b.js'] },
    { index: 1, shardIndexes: [2], text: '7890', paths: ['c.js'] },
  ]);
  assert.equal(groups.map((group) => group.text).join(''), '1234567890');
  assert.ok(groups.every((group) => group.text.length <= 6));
  assert.throws(() => groupShards([{ index: 0, text: '1234567', paths: [] }], { maxChars: 6 }), /exceeds/);
});
