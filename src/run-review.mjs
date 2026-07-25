#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { executeReview } from './review-entry.mjs';
import { createManifest } from './artifact-manifest.mjs';

const required = [
  'CENTRAL_ROOT', 'CALLER_ROOT', 'REPOSITORY', 'POLICY_FILE', 'DIFF_PATH', 'CONTEXT_PATH',
  'OUTPUT_DIRECTORY', 'WORKFLOW_REF', 'REVIEW_HEAD_OID', 'GITHUB_RUN_ID',
];
for (const key of required) {
  if (typeof process.env[key] !== 'string' || process.env[key].length === 0) throw new Error(`${key} is required`);
}

const centralRoot = path.resolve(process.env.CENTRAL_ROOT);
const callerRoot = path.resolve(process.env.CALLER_ROOT);
const outputDirectory = path.resolve(process.env.OUTPUT_DIRECTORY);
const context = JSON.parse(await readFile(process.env.CONTEXT_PATH, 'utf8'));
const policy = JSON.parse(await readFile(process.env.POLICY_FILE, 'utf8'));
const diff = await readFile(process.env.DIFF_PATH, 'utf8');
const { review, markdown } = await executeReview({
  centralRoot,
  callerRoot,
  repository: process.env.REPOSITORY,
  diff,
  policy,
  environment: process.env,
  maxDiffChars: process.env.MAX_DIFF_CHARS,
  maxShardChars: process.env.MAX_SHARD_CHARS,
  workerTimeoutMs: process.env.WORKER_TIMEOUT_MS,
  shadow: process.env.SHADOW === 'true',
});
const artifacts = {
  'review.json': `${JSON.stringify(review, null, 2)}\n`,
  'review.md': markdown,
};
const manifest = createManifest({
  context,
  runId: process.env.GITHUB_RUN_ID,
  workflowRef: process.env.WORKFLOW_REF,
  reviewOid: process.env.REVIEW_HEAD_OID,
  artifacts,
});
await Promise.all([
  writeFile(path.join(outputDirectory, 'review.json'), artifacts['review.json']),
  writeFile(path.join(outputDirectory, 'review.md'), artifacts['review.md']),
  writeFile(path.join(outputDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`),
]);
if (review.decision === 'infrastructure_failure') process.exitCode = 2;
else if (review.decision === 'request_changes' && process.env.SHADOW !== 'true') process.exitCode = 3;
