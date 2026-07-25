#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { executeReview } from './review-entry.mjs';
import { createManifest } from './artifact-manifest.mjs';
import { sha256 } from './pr-context.mjs';

const required = [
  'CENTRAL_ROOT', 'CALLER_ROOT', 'REPOSITORY', 'POLICY_FILE', 'DIFF_PATH', 'CONTEXT_PATH',
  'OUTPUT_DIRECTORY', 'WORKFLOW_REF', 'REVIEW_HEAD_OID', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT',
  'CLAUDE_EXECUTABLE', 'RIPGREP_EXECUTABLE', 'BWRAP_EXECUTABLE',
];
for (const key of required) {
  if (typeof process.env[key] !== 'string' || process.env[key].length === 0) throw new Error(`${key} is required`);
}

const centralRoot = path.resolve(process.env.CENTRAL_ROOT);
const callerRoot = path.resolve(process.env.CALLER_ROOT);
const outputDirectory = path.resolve(process.env.OUTPUT_DIRECTORY);
const context = JSON.parse(await readFile(process.env.CONTEXT_PATH, 'utf8'));
const policyBytes = await readFile(process.env.POLICY_FILE, 'utf8');
const policy = JSON.parse(policyBytes);
const policySha256 = sha256(policyBytes);
const diff = await readFile(process.env.DIFF_PATH, 'utf8');
const executable = path.resolve(process.env.CLAUDE_EXECUTABLE);
const ripgrepExecutable = path.resolve(process.env.RIPGREP_EXECUTABLE);
const sandboxExecutable = path.resolve(process.env.BWRAP_EXECUTABLE);
const { review, markdown } = await executeReview({
  centralRoot,
  callerRoot,
  repository: process.env.REPOSITORY,
  diff,
  policy,
  policySha256,
  environment: process.env,
  executable,
  ripgrepExecutable,
  sandboxExecutable,
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
  runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  workflowRef: process.env.WORKFLOW_REF,
  reviewOid: process.env.REVIEW_HEAD_OID,
  policySha256,
  artifacts,
});
await Promise.all([
  writeFile(path.join(outputDirectory, 'review.json'), artifacts['review.json']),
  writeFile(path.join(outputDirectory, 'review.md'), artifacts['review.md']),
  writeFile(path.join(outputDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`),
]);
if (review.decision === 'infrastructure_failure') process.exitCode = 2;
else if (review.decision === 'request_changes' && process.env.SHADOW !== 'true') process.exitCode = 3;
