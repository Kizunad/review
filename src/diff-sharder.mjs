import path from 'node:path';
import { realpath } from 'node:fs/promises';

export function safeRelativePath(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.includes('\0')) {
    throw new TypeError('path must be a non-empty string without NUL');
  }
  const normalizedSeparators = candidate.replaceAll('\\', '/');
  const components = normalizedSeparators.split('/');
  if (path.posix.isAbsolute(normalizedSeparators) || components.includes('..')) {
    throw new Error(`unsafe relative path: ${candidate}`);
  }
  const normalized = components
    .filter((component) => component !== '' && component !== '.')
    .join('/');
  if (normalized.length === 0) {
    throw new Error(`unsafe relative path: ${candidate}`);
  }
  return normalized;
}

export async function resolveInsideRoot(root, candidate) {
  const canonicalPath = safeRelativePath(candidate);
  const resolvedRoot = await realpath(root);
  const resolvedTarget = await realpath(path.join(resolvedRoot, canonicalPath));
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
    const rawPathName = headerPath(section.split('\n', 1)[0]);
    const pathName = rawPathName ? safeRelativePath(rawPathName) : null;
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

export function groupShards(shards, { maxChars } = {}) {
  if (!Array.isArray(shards)) throw new TypeError('shards must be an array');
  if (!Number.isInteger(maxChars) || maxChars < 1) throw new RangeError('maxChars must be positive');
  const groups = [];
  let current = [];
  let chars = 0;
  const flush = () => {
    if (current.length > 0) {
      groups.push({
        index: groups.length,
        shardIndexes: current.map((shard) => shard.index),
        text: current.map((shard) => shard.text).join(''),
        paths: [...new Set(current.flatMap((shard) => shard.paths))],
      });
    }
    current = [];
    chars = 0;
  };

  for (const shard of shards) {
    if (!shard || !Number.isInteger(shard.index) || typeof shard.text !== 'string' || !Array.isArray(shard.paths)) {
      throw new TypeError('every shard must contain an integer index, text, and paths');
    }
    if (shard.text.length > maxChars) throw new RangeError(`shard ${shard.index} exceeds ${maxChars} characters`);
    if (current.length > 0 && chars + shard.text.length > maxChars) flush();
    current.push(shard);
    chars += shard.text.length;
  }
  flush();
  return groups;
}
