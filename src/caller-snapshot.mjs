import path from 'node:path';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const EXCLUDED_NAMES = new Set([
  '.claude',
  '.git',
  '.mcp.json',
  'AGENTS.md',
  'CLAUDE.md',
]);

function assertDirectoryEntryName(name) {
  if (name.includes('\0') || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new Error(`unsafe repository entry name: ${name}`);
  }
}

async function copyTree(sourceDirectory, targetDirectory, relativeDirectory = '') {
  const entries = await readdir(sourceDirectory, { withFileTypes: true });
  for (const entry of entries) {
    assertDirectoryEntryName(entry.name);
    if (EXCLUDED_NAMES.has(entry.name)) continue;
    const relative = relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name;
    const source = path.join(sourceDirectory, entry.name);
    const target = path.join(targetDirectory, relative);
    const info = await lstat(source);
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      await mkdir(target, { recursive: true });
      await copyTree(source, targetDirectory, relative);
      await chmod(target, 0o555);
    } else if (info.isFile()) {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, await readFile(source), { mode: 0o444 });
    } else {
      throw new Error(`caller snapshot contains a non-regular entry: ${relative}`);
    }
  }
}

async function makeTreeWritable(directory) {
  await chmod(directory, 0o700);
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await makeTreeWritable(target);
    else await chmod(target, 0o600);
  }
}

export async function createSanitizedCallerSnapshot(callerRoot, { temporaryRoot = tmpdir() } = {}) {
  const source = await realpath(callerRoot);
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isDirectory()) throw new Error('callerRoot must be a directory');
  const container = await mkdtemp(path.join(temporaryRoot, 'central-review-caller-'));
  const root = path.join(container, 'repository');
  const home = path.join(container, 'home');
  await Promise.all([mkdir(root), mkdir(home)]);
  try {
    await copyTree(source, root);
    await chmod(root, 0o555);
  } catch (error) {
    await rm(container, { recursive: true, force: true });
    throw error;
  }
  return {
    root,
    home,
    cleanup: async () => {
      await makeTreeWritable(root);
      await rm(container, { recursive: true, force: true });
    },
  };
}

export function isExcludedReviewPath(relativePath) {
  return String(relativePath).split(/[\\/]+/).some((component) => EXCLUDED_NAMES.has(component));
}
