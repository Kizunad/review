import { readFile, stat } from 'node:fs/promises';

export async function readBoundedUtf8File(filePath, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError('maxBytes must be a positive safe integer');
  }
  const fileStats = await stat(filePath);
  if (!fileStats.isFile()) throw new Error('DIFF_PATH must be a regular file');
  return {
    text: fileStats.size <= maxBytes ? await readFile(filePath, 'utf8') : '',
    byteLength: fileStats.size,
  };
}
