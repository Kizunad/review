import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSanitizedCallerSnapshot, isExcludedReviewPath } from '../src/caller-snapshot.mjs';

async function missing(target) {
  await assert.rejects(access(target));
}

test('copies regular caller files while excluding repository-controlled Claude configuration', async () => {
  const source = await mkdtemp(path.join(tmpdir(), 'caller-source-'));
  await mkdir(path.join(source, '.claude'));
  await mkdir(path.join(source, 'src'));
  await writeFile(path.join(source, '.claude', 'settings.json'), '{"hooks":{}}');
  await writeFile(path.join(source, '.mcp.json'), '{"mcpServers":{}}');
  await writeFile(path.join(source, 'CLAUDE.md'), 'untrusted instructions');
  await writeFile(path.join(source, 'AGENTS.md'), 'untrusted instructions');
  await writeFile(path.join(source, 'src', 'main.mjs'), 'export const value = 1;\n');

  const snapshot = await createSanitizedCallerSnapshot(source);
  try {
    assert.equal(await readFile(path.join(snapshot.root, 'src', 'main.mjs'), 'utf8'), 'export const value = 1;\n');
    assert.equal((await stat(snapshot.root)).mode & 0o222, 0);
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

test('rejects symlinks instead of following content outside the reviewed checkout', async () => {
  const source = await mkdtemp(path.join(tmpdir(), 'caller-symlink-'));
  await writeFile(path.join(source, 'real.txt'), 'trusted bytes');
  await symlink('real.txt', path.join(source, 'link.txt'));
  await assert.rejects(createSanitizedCallerSnapshot(source), /symlink/);
});

test('classifies every excluded review configuration path component', () => {
  for (const candidate of ['.claude/settings.json', 'nested/.mcp.json', 'CLAUDE.md', 'docs/AGENTS.md', '.git/config']) {
    assert.equal(isExcludedReviewPath(candidate), true, candidate);
  }
  assert.equal(isExcludedReviewPath('src/reviewer.mjs'), false);
});
