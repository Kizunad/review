import test from 'node:test';
import assert from 'node:assert/strict';
import { createManifest, verifyManifest } from '../src/artifact-manifest.mjs';
import { canFinalize, finalize } from '../src/finalizer.mjs';

const context = { repository: 'org/repo', pullNumber: 4, baseOid: 'a'.repeat(40), headOid: 'b'.repeat(40) };
const artifacts = { 'review.json': '{"decision":"approve"}', 'review.md': '## Review\n\nApproved.\n' };
const input = {
  context,
  runId: 88,
  runAttempt: 2,
  workflowRef: 'c'.repeat(40),
  reviewOid: 'b'.repeat(40),
  policySha256: 'd'.repeat(64),
  artifacts,
};

test('manifest binds every published artifact byte to exact caller PR and run', () => {
  const manifest = createManifest(input);
  assert.equal(verifyManifest(manifest, context, artifacts, {
    runId: 88,
    runAttempt: 2,
    workflowRef: 'c'.repeat(40),
    policySha256: 'd'.repeat(64),
  }), true);
  assert.throws(() => verifyManifest(manifest, context, artifacts, { runAttempt: 3 }), /runAttempt/);
  assert.throws(() => verifyManifest(manifest, context, artifacts, { policySha256: 'e'.repeat(64) }), /policySha256/);
  assert.throws(() => verifyManifest(manifest, { ...context, headOid: 'd'.repeat(40) }, artifacts), /headOid/);
  assert.throws(() => verifyManifest(manifest, context, { ...artifacts, 'review.json': '{"decision":"request_changes"}' }), /review.json hash/);
  assert.throws(() => verifyManifest(manifest, context, { ...artifacts, 'review.md': `${artifacts['review.md']}\n` }), /review.md hash/);
  assert.throws(() => createManifest({ ...input, reviewOid: 'd'.repeat(40) }), /must equal/);
});

test('rejects forged declarations, missing files, and non-canonical manifest fields', () => {
  const manifest = createManifest(input);
  assert.throws(() => verifyManifest({ ...manifest, extra: true }, context, artifacts), /fields/);
  assert.throws(() => verifyManifest({ ...manifest, version: 'v1' }, context, artifacts), /version/);
  assert.throws(() => verifyManifest(manifest, context, { 'review.json': artifacts['review.json'] }), /fields/);
  assert.throws(() => createManifest({ ...input, artifacts: { ...artifacts, 'extra.txt': 'x' } }), /fields/);
});

test('finalizer refetches, rejects stale head, and publishes only bound markdown', async () => {
  const manifest = createManifest(input);
  assert.throws(() => canFinalize({ manifest, currentPullRequest: { ...context, headOid: 'd'.repeat(40) }, artifacts }), /headOid/);
  const comments = [];
  await finalize({
    fetchPullRequest: async () => context,
    postComment: async (target, body) => comments.push({ target, body }),
    manifest,
    artifacts,
    binding: {
      runId: 88,
      runAttempt: 2,
      workflowRef: 'c'.repeat(40),
      policySha256: 'd'.repeat(64),
    },
  });
  assert.deepEqual(comments, [{
    target: { repository: 'org/repo', pullNumber: 4, headOid: 'b'.repeat(40) },
    body: artifacts['review.md'],
  }]);
});
