import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';

export async function assertInsideWorkspace(workspaceRoot, candidate) {
  const root = await realpath(workspaceRoot);
  const target = await realpath(candidate);
  const relative = path.relative(root, target);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`path escapes workspace boundary: ${candidate}`);
  }
  return target;
}

export function safeRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new Error('path must be a non-empty string');
  }
  if (path.isAbsolute(value) || value.split(/[\\/]+/).includes('..')) {
    throw new Error(`unsafe relative path: ${value}`);
  }
  return value;
}

export async function assertRegularFileInsideWorkspace(workspaceRoot, candidate) {
  const relative = safeRelativePath(candidate);
  const root = await realpath(workspaceRoot);
  let current = root;
  for (const component of relative.split(/[\\/]+/)) {
    current = path.join(current, component);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error(`path contains a symlink: ${candidate}`);
  }
  const target = await assertInsideWorkspace(root, current);
  const info = await lstat(target);
  if (!info.isFile()) throw new Error(`path is not a regular file: ${candidate}`);
  return { path: target, size: info.size };
}

export function checkoutDirectory(workspaceRoot, name) {
  safeRelativePath(name);
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name)) throw new Error(`unsafe checkout name: ${name}`);
  return path.join(workspaceRoot, name);
}
