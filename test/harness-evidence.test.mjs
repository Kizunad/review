import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EVIDENCE_VERSION, scanEvidence, validateEvidence } from '../harness/evidence.mjs';

const HEAD = 'a'.repeat(40);

function evidence(overrides = {}) {
  return {
    version: EVIDENCE_VERSION,
    assignmentId: 'a1',
    mode: 'test',
    worker: 'W1',
    headOid: HEAD,
    commands: ['harness/scrub-env.sh npm test'],
    artifacts: ['a1/regression.test.mjs', 'a1/run.log'],
    exitCodes: [1],
    verdict: 'fail',
    notes: 'counterexample passes on main and fails on the PR head',
    binaryProvenance: null,
    ...overrides,
  };
}

test('accepts a complete test-mode evidence record bound to the reviewed head', () => {
  const { ok, errors } = validateEvidence(evidence(), { headOid: HEAD });
  assert.deepEqual(errors, []);
  assert.equal(ok, true);
});

test('rejects missing, extra, or renamed fields outright', () => {
  const { extra, ...rest } = { ...evidence(), extra: true };
  assert.equal(validateEvidence({ ...rest, extra: 1 }).ok, false);
  const { notes, ...missing } = evidence();
  assert.equal(validateEvidence(missing).ok, false);
  assert.equal(validateEvidence(null).ok, false);
  assert.equal(validateEvidence([]).ok, false);
});

test('rejects evidence bound to a different head than the review', () => {
  const { ok, errors } = validateEvidence(evidence({ headOid: 'b'.repeat(40) }), { headOid: HEAD });
  assert.equal(ok, false);
  assert.match(errors.join(' '), /does not match the reviewed PR head/);
});

test('rejects unsafe artifact paths and unbounded command lists', () => {
  assert.equal(validateEvidence(evidence({ artifacts: ['/etc/passwd'] })).ok, false);
  assert.equal(validateEvidence(evidence({ artifacts: ['a1/../../escape'] })).ok, false);
  assert.equal(validateEvidence(evidence({ commands: [] })).ok, false);
  assert.equal(validateEvidence(evidence({ exitCodes: [256] })).ok, false);
  assert.equal(validateEvidence(evidence({ exitCodes: [] })).ok, false);
});

test('enforces the binary provenance law per mode', () => {
  // P1 的 test/static 模式没有被测二进制:不允许携带出处。
  assert.equal(validateEvidence(evidence({ binaryProvenance: { headOid: HEAD, buildRunId: 'r1' } })).ok, false);
  // probe 必须携带出处,且出处 head 必须等于证据 head(测的就是审的)。
  assert.equal(validateEvidence(evidence({ mode: 'probe' })).ok, false);
  assert.equal(validateEvidence(evidence({ mode: 'probe', binaryProvenance: { headOid: HEAD, buildRunId: 'run-77' } })).ok, true);
  assert.equal(validateEvidence(evidence({ mode: 'probe', binaryProvenance: { headOid: 'c'.repeat(40), buildRunId: 'run-77' } })).ok, false);
  assert.equal(validateEvidence(evidence({ mode: 'probe', binaryProvenance: { headOid: HEAD } })).ok, false);
  // adversarial 可无二进制,但带出处时同样受铁律约束。
  assert.equal(validateEvidence(evidence({ mode: 'adversarial' })).ok, true);
  assert.equal(validateEvidence(evidence({ mode: 'adversarial', binaryProvenance: { headOid: 'c'.repeat(40), buildRunId: 'r' } })).ok, false);
});

test('scan treats only contract-valid on-disk evidence as completed', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'evidence-scan-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'a1.json'), JSON.stringify(evidence()));
  await writeFile(path.join(root, 'a2.json'), JSON.stringify(evidence({ assignmentId: 'a2', verdict: 'pass', exitCodes: [0] })));
  // 文件名与 assignmentId 不一致:一份证据不能冒领另一个分片。
  await writeFile(path.join(root, 'a3.json'), JSON.stringify(evidence({ assignmentId: 'a9' })));
  await writeFile(path.join(root, 'broken.json'), '{not json');
  await writeFile(path.join(root, 'wrong-head.json'), JSON.stringify(evidence({ assignmentId: 'wrong-head', headOid: 'b'.repeat(40) })));
  await mkdir(path.join(root, 'a1'));
  await writeFile(path.join(root, 'notes.txt'), 'ignored');

  const { completed, invalid } = await scanEvidence(root, { headOid: HEAD });
  assert.deepEqual(completed.map((entry) => entry.assignmentId), ['a1', 'a2']);
  assert.deepEqual(invalid.map((entry) => entry.file).sort(), ['a3.json', 'broken.json', 'wrong-head.json']);
});

test('scan rejects symlinked evidence files and missing directories quietly', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'evidence-links-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'real.json'), JSON.stringify(evidence({ assignmentId: 'real' })));
  await symlink(path.join(root, 'real.json'), path.join(root, 'link.json'));
  const { completed } = await scanEvidence(root, { headOid: HEAD });
  // symlink 解析后仍是常规文件,但文件名 link.json 与 assignmentId real 不一致而被拒。
  assert.deepEqual(completed.map((entry) => entry.assignmentId), ['real']);
  assert.deepEqual(await scanEvidence(path.join(root, 'absent')), { completed: [], invalid: [] });
});
