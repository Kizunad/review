import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

test('rejects non-files and invalid byte limits', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'diff-input-invalid-'));
  await mkdir(path.join(root, 'directory'));

  await assert.rejects(
    () => readBoundedUtf8File(path.join(root, 'directory'), ONE_MIB),
    /regular file/,
  );
  for (const maxBytes of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(
      () => readBoundedUtf8File(path.join(root, 'missing'), maxBytes),
      /positive safe integer/,
    );
  }
});
