export async function readBoundedUtf8Handle(handle, fileStats, maxBytes) {
  if (!fileStats.isFile()) throw new Error('DIFF_PATH must be a regular file');
  if (fileStats.size > maxBytes) return { text: '', byteLength: fileStats.size };

  const chunks = [];
  let byteLength = 0;
  let reachedEof = false;
  while (byteLength <= maxBytes && !reachedEof) {
    const remaining = maxBytes + 1 - byteLength;
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
    let filled = 0;
    while (filled < buffer.length) {
      const result = await handle.read(
        buffer,
        filled,
        buffer.length - filled,
        byteLength,
      );
      if (result.bytesRead === 0) {
        reachedEof = true;
        break;
      }
      filled += result.bytesRead;
      byteLength += result.bytesRead;
    }
    if (filled > 0) chunks.push(buffer.subarray(0, filled));
  }
  return byteLength > maxBytes
    ? { text: '', byteLength }
    : { text: Buffer.concat(chunks, byteLength).toString('utf8'), byteLength };
}
