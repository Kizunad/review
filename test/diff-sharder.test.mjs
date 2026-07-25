import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveInsideRoot, safeRelativePath, shardDiff } from '../src/diff-sharder.mjs';

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

test('shards empty, normal, and oversized diffs deterministically', () => {
  assert.deepEqual(shardDiff(''), []);
  const first = 'diff --git a/a.js b/a.js\n+one\n';
  const second = 'diff --git a/b.js b/b.js\n+two\n';
  const shards = shardDiff(first + second, { maxChars: first.length + 1 });
  assert.equal(shards.length, 2);
  assert.deepEqual(shards.map((entry) => entry.paths), [['a.js'], ['b.js']]);
  const large = `diff --git a/large.js b/large.js\n${'+x'.repeat(20)}`;
  const split = shardDiff(large, { maxChars: 15 });
  assert.ok(split.length > 1);
  assert.ok(split.every((entry) => entry.text.length <= 15));
});
