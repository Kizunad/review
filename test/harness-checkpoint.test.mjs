import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CHECKPOINT_VERSION,
  acceptCheckpoint,
  buildCheckpoint,
  runCli,
  validCheckpointKey,
} from '../harness/checkpoint.mjs';
import { EVIDENCE_VERSION } from '../harness/evidence.mjs';

const HEAD = 'a'.repeat(40);
const PIN = 'b'.repeat(40);
const KEY = { pullNumber: 1315, headOid: HEAD, enginePin: PIN };

function evidence(assignmentId) {
  return {
    version: EVIDENCE_VERSION,
    assignmentId,
    mode: 'test',
    worker: 'W1',
    headOid: HEAD,
    commands: ['harness/scrub-env.sh npm test'],
    artifacts: [],
    exitCodes: [0],
    verdict: 'pass',
    notes: '',
    binaryProvenance: null,
  };
}

test('checkpoint keys demand pr, head, and engine pin exactly', () => {
  assert.equal(validCheckpointKey(KEY), true);
  assert.equal(validCheckpointKey({ ...KEY, headOid: 'short' }), false);
  assert.equal(validCheckpointKey({ ...KEY, pullNumber: 0 }), false);
  assert.equal(validCheckpointKey({ pullNumber: 1, headOid: HEAD }), false);
  assert.equal(validCheckpointKey({ ...KEY, extra: 1 }), false);
});

test('build produces a sorted, deduplicated completion list', () => {
  const checkpoint = buildCheckpoint({
    key: KEY,
    runId: 'run-9',
    ledger: 'W1\ta2\t2026-08-08T00:00Z\tdispatched\n',
    completedAssignments: ['b2', 'a1', 'b2'],
  });
  assert.equal(checkpoint.version, CHECKPOINT_VERSION);
  assert.deepEqual(checkpoint.completedAssignments, ['a1', 'b2']);
  assert.throws(() => buildCheckpoint({ key: KEY, runId: 'run-9', ledger: '', completedAssignments: ['../x'] }), /assignment ids/);
  assert.throws(() => buildCheckpoint({ key: KEY, runId: '', ledger: '', completedAssignments: [] }), /runId/);
});

test('resume is discarded when any of pr, head, or engine pin differ', () => {
  const checkpoint = buildCheckpoint({ key: KEY, runId: 'run-1', ledger: '', completedAssignments: ['a1'] });
  assert.equal(acceptCheckpoint(checkpoint, KEY).ok, true);
  for (const mutation of [
    { pullNumber: 1316 },
    { headOid: 'c'.repeat(40) },
    { enginePin: 'd'.repeat(40) },
  ]) {
    const outcome = acceptCheckpoint(checkpoint, { ...KEY, ...mutation });
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason, /does not match this run/);
  }
});

test('resume rejects foreign or malformed checkpoint payloads', () => {
  assert.equal(acceptCheckpoint(null, KEY).ok, false);
  assert.equal(acceptCheckpoint({ hello: 1 }, KEY).ok, false);
  const checkpoint = buildCheckpoint({ key: KEY, runId: 'run-1', ledger: '', completedAssignments: [] });
  assert.equal(acceptCheckpoint({ ...checkpoint, version: 'v1' }, KEY).ok, false);
  assert.equal(acceptCheckpoint({ ...checkpoint, completedAssignments: ['..'] }, KEY).ok, false);
  assert.equal(acceptCheckpoint({ ...checkpoint, runId: 42 }, KEY).ok, false);
});

test('accepted resume reports the prior run id and sorted completions', () => {
  const checkpoint = buildCheckpoint({ key: KEY, runId: 'prior-run', ledger: 'x', completedAssignments: ['z9', 'a1'] });
  const outcome = acceptCheckpoint(checkpoint, KEY);
  assert.deepEqual(outcome, { ok: true, completedAssignments: ['a1', 'z9'], resumedFrom: 'prior-run' });
});

test('write CLI derives completion only from contract-valid evidence on disk', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'checkpoint-cli-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const environment = {
    HARNESS_DIR: root, PR_NUMBER: '1315', HEAD_OID: HEAD, ENGINE_PIN: PIN, RUN_ID: 'run-42',
  };
  await mkdir(path.join(root, 'evidence'), { recursive: true });
  await writeFile(path.join(root, 'evidence', 'a1.json'), JSON.stringify(evidence('a1')));
  await writeFile(path.join(root, 'evidence', 'bad.json'), '{broken');
  await writeFile(path.join(root, 'ledger.tsv'), 'W1\ta1\t2026-08-08T00:00Z\tdispatched\n');

  const written = await runCli('write', environment);
  assert.deepEqual(written.completed, ['a1']);
  const stored = JSON.parse(await readFile(path.join(root, 'checkpoint', 'checkpoint.json'), 'utf8'));
  assert.deepEqual(stored.completedAssignments, ['a1']);
  assert.equal(stored.runId, 'run-42');
  assert.match(stored.ledger, /dispatched/);

  // resume 往返:同键接受,产出 completed.txt 与 resumed-from.txt。
  await mkdir(path.join(root, 'resume'), { recursive: true });
  await writeFile(path.join(root, 'resume', 'checkpoint.json'), JSON.stringify(stored));
  const resumed = await runCli('resume', environment);
  assert.deepEqual(resumed, { resumed: true, completed: ['a1'], resumedFrom: 'run-42' });
  assert.equal(await readFile(path.join(root, 'resume', 'completed.txt'), 'utf8'), 'a1\n');
  assert.equal(await readFile(path.join(root, 'resume', 'resumed-from.txt'), 'utf8'), 'run-42\n');

  // 键不符即作废:清空 completed.txt,不产 resumed-from。
  const foreign = await runCli('resume', { ...environment, HEAD_OID: 'e'.repeat(40) });
  assert.equal(foreign.resumed, false);
  assert.match(foreign.reason, /headOid does not match/);
  assert.equal(await readFile(path.join(root, 'resume', 'completed.txt'), 'utf8'), '');
  await assert.rejects(readFile(path.join(root, 'resume', 'resumed-from.txt'), 'utf8'), /ENOENT/);
});

test('resume CLI treats a missing checkpoint as a fresh run', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'checkpoint-fresh-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const outcome = await runCli('resume', {
    HARNESS_DIR: root, PR_NUMBER: '7', HEAD_OID: HEAD, ENGINE_PIN: PIN, RUN_ID: 'run-1',
  });
  assert.deepEqual(outcome, { resumed: false, reason: 'no resume checkpoint present' });
  assert.equal(await readFile(path.join(root, 'resume', 'completed.txt'), 'utf8'), '');
});
