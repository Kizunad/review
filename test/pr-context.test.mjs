import test from 'node:test';
import assert from 'node:assert/strict';
import { assertOid, canonicalJson, parsePullRequest } from '../src/pr-context.mjs';

const oid = 'a'.repeat(40);

test('validates immutable pull request identities', () => {
  assert.deepEqual(parsePullRequest({ repository: 'org/repo', pullNumber: '8', baseOid: oid, headOid: 'b'.repeat(40) }), {
    repository: 'org/repo', pullNumber: 8, baseOid: oid, headOid: 'b'.repeat(40),
  });
  assert.throws(() => assertOid('main'), /40-character/);
  assert.throws(() => parsePullRequest({ repository: '../repo', pullNumber: 0, baseOid: oid, headOid: oid }), /owner/);
});

test('canonical JSON is order independent', () => {
  assert.equal(canonicalJson({ b: 1, a: { z: false, c: true } }), canonicalJson({ a: { c: true, z: false }, b: 1 }));
});
