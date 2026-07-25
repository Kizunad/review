import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertInsideWorkspace, checkoutDirectory, safeRelativePath } from '../src/workspace-boundary.mjs';

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
