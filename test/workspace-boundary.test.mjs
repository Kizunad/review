import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertInsideWorkspace, assertRegularFileInsideWorkspace, checkoutDirectory, safeRelativePath } from '../src/workspace-boundary.mjs';

test('rejects traversal and symlink escapes', async () => {
  assert.throws(() => safeRelativePath('../repo'), /unsafe/);
  assert.throws(() => checkoutDirectory('/tmp/work', 'caller/repo'), /unsafe/);
  const root = await mkdtemp(path.join(tmpdir(), 'boundary-'));
  const child = path.join(root, 'child');
  await mkdir(child);
  assert.equal(await assertInsideWorkspace(root, child), child);
  await symlink(tmpdir(), path.join(root, 'escape'));
  await assert.rejects(assertInsideWorkspace(root, path.join(root, 'escape')), /escapes/);
});

test('accepts only regular files with no symlink component', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'regular-boundary-'));
  await mkdir(path.join(root, 'policy'));
  await writeFile(path.join(root, 'policy', 'review.json'), '{}');
  const regular = await assertRegularFileInsideWorkspace(root, 'policy/review.json');
  assert.equal(regular.path, path.join(root, 'policy', 'review.json'));
  assert.equal(regular.size, 2);

  await symlink('policy/review.json', path.join(root, 'policy-link.json'));
  await assert.rejects(assertRegularFileInsideWorkspace(root, 'policy-link.json'), /symlink/);
  await symlink('policy', path.join(root, 'policy-dir-link'));
  await assert.rejects(assertRegularFileInsideWorkspace(root, 'policy-dir-link/review.json'), /symlink/);
  await assert.rejects(assertRegularFileInsideWorkspace(root, 'policy'), /regular file/);
});
