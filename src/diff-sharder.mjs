import path from 'node:path';
import { realpath } from 'node:fs/promises';

export function safeRelativePath(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.includes('\0')) {
    throw new TypeError('path must be a non-empty string without NUL');
  }
  if (path.isAbsolute(candidate) || candidate.split(/[\\/]+/).includes('..')) {
    throw new Error(`unsafe relative path: ${candidate}`);
  }
  return candidate;
}

export async function resolveInsideRoot(root, candidate) {
  safeRelativePath(candidate);
  const resolvedRoot = await realpath(root);
  const resolvedTarget = await realpath(path.join(resolvedRoot, candidate));
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`path escapes root: ${candidate}`);
  }
  return resolvedTarget;
}

function headerPath(header) {
  const match = /^diff --git a\/(.+) b\/(.+)$/.exec(header);
  return match?.[2] ?? null;
}

export function shardDiff(diffText, { maxChars = 12_000 } = {}) {
  if (typeof diffText !== 'string') throw new TypeError('diffText must be a string');
  if (!Number.isInteger(maxChars) || maxChars < 1) throw new RangeError('maxChars must be positive');
  if (diffText === '') return [];

  const sections = diffText.split(/(?=^diff --git )/m).filter(Boolean);
  const shards = [];
  let current = '';
  let paths = [];
  const flush = () => {
    if (current) shards.push({ index: shards.length, text: current, paths: [...new Set(paths)] });
    current = '';
    paths = [];
  };

  for (const section of sections) {
    const pathName = headerPath(section.split('\n', 1)[0]);
    if (pathName) safeRelativePath(pathName);
    if (current && current.length + section.length > maxChars) flush();
    if (section.length <= maxChars) {
      current += section;
      if (pathName) paths.push(pathName);
      continue;
    }

    flush();
    for (let offset = 0; offset < section.length; offset += maxChars) {
      const text = section.slice(offset, offset + maxChars);
      shards.push({ index: shards.length, text, paths: pathName ? [pathName] : [] });
    }
  }
  flush();
  return shards;
}
