import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { readBoundedUtf8Handle } from './diff-input-internal.mjs';

export async function readBoundedUtf8File(filePath, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError('maxBytes must be a positive safe integer');
  }
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    return await readBoundedUtf8Handle(handle, await handle.stat(), maxBytes);
  } finally {
    await handle.close();
  }
}
