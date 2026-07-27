import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, open, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readBoundedUtf8Handle } from '../src/diff-input-internal.mjs';
import { readBoundedUtf8File } from '../src/diff-input.mjs';

const ONE_MIB = 1_048_576;

test('reads raw diff files at the exact UTF-8 byte limit', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'diff-input-exact-'));
  const diffPath = path.join(root, 'review.diff');
  const text = '界'.repeat(349_525) + 'x';
  assert.equal(Buffer.byteLength(text), ONE_MIB);
  await writeFile(diffPath, text);

  const result = await readBoundedUtf8File(diffPath, ONE_MIB);
  assert.equal(result.byteLength, ONE_MIB);
  assert.equal(result.text, text);
});

test('reads astral raw diff files at the exact UTF-8 byte limit', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'diff-input-astral-'));
  const diffPath = path.join(root, 'review.diff');
  const text = '😀'.repeat(ONE_MIB / 4);
  assert.equal(text.length, ONE_MIB / 2);
  assert.equal(Buffer.byteLength(text), ONE_MIB);
  await writeFile(diffPath, text);

  const result = await readBoundedUtf8File(diffPath, ONE_MIB);
  assert.equal(result.byteLength, ONE_MIB);
  assert.equal(result.text, text);
});

test('does not read raw diff files above the UTF-8 byte limit', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'diff-input-over-'));
  const diffPath = path.join(root, 'review.diff');
  await writeFile(diffPath, 'x'.repeat(ONE_MIB + 1));

  const result = await readBoundedUtf8File(diffPath, ONE_MIB);
  assert.equal(result.byteLength, ONE_MIB + 1);
  assert.equal(result.text, '');
});

test('bounds reads when an opened file grows after its initial stat', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'diff-input-growth-'));
  const diffPath = path.join(root, 'review.diff');
  await writeFile(diffPath, 'x');
  const handle = await open(diffPath, 'r');
  try {
    const fileStats = await handle.stat();
    await writeFile(diffPath, 'x'.repeat(ONE_MIB + 1));
    const result = await readBoundedUtf8Handle(handle, fileStats, ONE_MIB);
    assert.equal(result.text, '');
    assert.equal(result.byteLength, ONE_MIB + 1);
  } finally {
    await handle.close();
  }
});

test('reads the opened inode when the path is replaced after stat', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'diff-input-replace-'));
  const diffPath = path.join(root, 'review.diff');
  const originalPath = path.join(root, 'original.diff');
  await writeFile(diffPath, 'trusted');
  const handle = await open(diffPath, 'r');
  try {
    const fileStats = await handle.stat();
    await rename(diffPath, originalPath);
    await writeFile(diffPath, 'replacement');
    const result = await readBoundedUtf8Handle(handle, fileStats, ONE_MIB);
    assert.equal(result.text, 'trusted');
    assert.equal(result.byteLength, Buffer.byteLength('trusted'));
  } finally {
    await handle.close();
  }
});

test('fills one bounded buffer across repeated short reads', async () => {
  const source = Buffer.from('short-read');
  let calls = 0;
  const handle = {
    async read(buffer, offset, _length, position) {
      calls += 1;
      if (position >= source.length) return { bytesRead: 0 };
      buffer[offset] = source[position];
      return { bytesRead: 1 };
    },
  };
  const fileStats = { isFile: () => true, size: source.length };

  const result = await readBoundedUtf8Handle(handle, fileStats, source.length);
  assert.equal(result.text, source.toString('utf8'));
  assert.equal(result.byteLength, source.length);
  assert.equal(calls, source.length + 1);
});

test('rejects non-files without blocking on a FIFO', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'diff-input-invalid-'));
  await mkdir(path.join(root, 'directory'));
  await assert.rejects(
    () => readBoundedUtf8File(path.join(root, 'directory'), ONE_MIB),
    /regular file/,
  );

  const fifoPath = path.join(root, 'review.fifo');
  execFileSync('mkfifo', [fifoPath]);
  const moduleUrl = new URL('../src/diff-input.mjs', import.meta.url).href;
  const script = `
    import { readBoundedUtf8File } from ${JSON.stringify(moduleUrl)};
    try {
      await readBoundedUtf8File(${JSON.stringify(fifoPath)}, ${ONE_MIB});
      process.exitCode = 2;
    } catch (error) {
      if (!/regular file/.test(error.message)) throw error;
    }
  `;
  execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
    timeout: 2_000,
  });
});

test('rejects invalid byte limits before opening the path', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'diff-input-limit-'));
  for (const maxBytes of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(
      () => readBoundedUtf8File(path.join(root, 'missing'), maxBytes),
      /positive safe integer/,
    );
  }
});
