import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSanitizedCallerSnapshot, isExcludedReviewPath } from '../src/caller-snapshot.mjs';

async function missing(target) {
  await assert.rejects(access(target));
}

async function sourceWithNestedFiles(prefix = 'caller-source-') {
  const source = await mkdtemp(path.join(tmpdir(), prefix));
  await mkdir(path.join(source, '.github', 'review-policy'), { recursive: true });
  await mkdir(path.join(source, 'src'));
  await writeFile(path.join(source, '.github', 'review-policy', 'project.json'), '{"version":1}\n');
  await writeFile(path.join(source, 'src', 'main.mjs'), 'export const value = 1;\n');
  return source;
}

test('copies regular caller files while excluding repository-controlled Claude configuration', async () => {
  const source = await sourceWithNestedFiles();
  await mkdir(path.join(source, '.claude'));
  await writeFile(path.join(source, '.claude', 'settings.json'), '{"hooks":{}}');
  await writeFile(path.join(source, '.mcp.json'), '{"mcpServers":{}}');
  await writeFile(path.join(source, 'CLAUDE.md'), 'untrusted instructions');
  await writeFile(path.join(source, 'AGENTS.md'), 'untrusted instructions');

  const snapshot = await createSanitizedCallerSnapshot(source);
  try {
    assert.equal(await readFile(path.join(snapshot.root, 'src', 'main.mjs'), 'utf8'), 'export const value = 1;\n');
    assert.equal((await stat(snapshot.root)).mode & 0o222, 0);
    assert.equal((await stat(path.join(snapshot.root, '.github'))).mode & 0o222, 0);
    assert.equal((await stat(path.join(snapshot.root, '.github', 'review-policy'))).mode & 0o222, 0);
    assert.equal((await stat(path.join(snapshot.root, 'src'))).mode & 0o222, 0);
    assert.equal((await stat(path.join(snapshot.root, 'src', 'main.mjs'))).mode & 0o222, 0);
    await missing(path.join(snapshot.root, '.claude'));
    await missing(path.join(snapshot.root, '.mcp.json'));
    await missing(path.join(snapshot.root, 'CLAUDE.md'));
    await missing(path.join(snapshot.root, 'AGENTS.md'));
    assert.notEqual(snapshot.home, process.env.HOME);
  } finally {
    await snapshot.cleanup();
  }
  await missing(snapshot.root);
});

test('cleanup restores traversal before removing nested read-only directories', async () => {
  const source = await sourceWithNestedFiles('caller-cleanup-');
  const snapshot = await createSanitizedCallerSnapshot(source);

  await assert.doesNotReject(snapshot.cleanup());
  await missing(snapshot.root);
});

test('excludes symlinks without following content inside or outside the reviewed checkout', async () => {
  const source = await mkdtemp(path.join(tmpdir(), 'caller-symlink-'));
  await mkdir(path.join(source, 'nested'));
  await writeFile(path.join(source, 'real.txt'), 'trusted bytes');
  await symlink('real.txt', path.join(source, 'link.txt'));
  await symlink(tmpdir(), path.join(source, 'nested', 'escape'));

  const snapshot = await createSanitizedCallerSnapshot(source);
  try {
    assert.equal(await readFile(path.join(snapshot.root, 'real.txt'), 'utf8'), 'trusted bytes');
    await missing(path.join(snapshot.root, 'link.txt'));
    await missing(path.join(snapshot.root, 'nested', 'escape'));
  } finally {
    await snapshot.cleanup();
  }
});

test('classifies every excluded review configuration path component', () => {
  for (const candidate of ['.claude/settings.json', 'nested/.mcp.json', 'CLAUDE.md', 'docs/AGENTS.md', '.git/config']) {
    assert.equal(isExcludedReviewPath(candidate), true, candidate);
  }
  assert.equal(isExcludedReviewPath('src/reviewer.mjs'), false);
});
