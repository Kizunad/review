import path from 'node:path';
import { realpath } from 'node:fs/promises';

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

export function checkoutDirectory(workspaceRoot, name) {
  safeRelativePath(name);
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name)) throw new Error(`unsafe checkout name: ${name}`);
  return path.join(workspaceRoot, name);
}
