import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const v2 = path.join(root, 'v2');
const harnessDir = path.join(root, 'harness');

const HEAD = 'a'.repeat(40);
const PIN = 'd'.repeat(40);

function tempDir(prefix) {
  return mkdtempSync(path.join(tmpdir(), `rv2-${prefix}-`));
}

// Identity + layout env shared by every bash shim and Node module.
function harnessEnv(stateRoot, extra = {}) {
  return {
    ...process.env,
    HARNESS_DIR: stateRoot,
    RV2_ROOT: stateRoot,
    RV2_REPOSITORY: 'Kizunad/review',
    PR_NUMBER: '1984',
    HEAD_OID: HEAD,
    ENGINE_PIN: PIN,
    RUN_ID: 'test-run-1',
    ...extra,
  };
}

function runScript(script, env, args = []) {
  return execFileSync(script, args, { cwd: root, env: harnessEnv(env.HARNESS_DIR, env), encoding: 'utf8' });
}

function validEvidence(id, worker = 'W1', extra = {}) {
  return {
    version: 'v2-evidence.1',
    assignmentId: id,
    mode: 'test',
    worker,
    headOid: HEAD,
    commands: ['node --test'],
    artifacts: [],
    exitCodes: [0],
    verdict: 'pass',
    notes: 'fixture',
    binaryProvenance: null,
    ...extra,
  };
}

// ---------------------------------------------------------------- workflow

test('review-v2-p1.yml declares the runner harness job in order', () => {
  const wf = readFileSync(path.join(root, '.github/workflows/review-v2-p1.yml'), 'utf8');

  assert.match(wf, /name:\s*review-v2-p1/);
  assert.match(wf, /workflow_call:/);
  assert.match(wf, /workflow_dispatch:/);

  const expected = [
    'Checkout engine',
    'Set up Node 22',
    'Install hash-pinned Claude Code',
    'Install runner harness (tmux + jq + pi + axonhub plugin)',
    'Prepare repo under review',
    'Build PR diff',
    'Restore prior checkpoint (resume)',
    'Boot harness session (trunk + workers + watchdog)',
    'Wait for review.json',
    'Wrapper validate / synthesize',
    'Upload artifacts',
  ];
  const names = [...wf.matchAll(/name:\s*([^\n]+)/g)].map((m) => m[1].trim());
  let prev = -1;
  for (const step of expected) {
    const i = names.indexOf(step);
    assert.ok(i > prev, `step "${step}" missing or out of order in review-v2-p1.yml`);
    prev = i;
  }

  // Node identity env + engine pin in the resume key (design 5.7c) + pins.
  assert.match(wf, /HARNESS_DIR:/);
  assert.match(wf, /PR_NUMBER:\s*\$\{\{ inputs\.pull_number \}\}/);
  assert.match(wf, /HEAD_OID:\s*\$\{\{ inputs\.head_oid \}\}/);
  assert.match(wf, /ENGINE_PIN:\s*\$\{\{ github\.sha \}\}/);
  assert.match(wf, /RUN_ID:\s*\$\{\{ github\.run_id \}\}/);
  assert.match(wf, /actions\/checkout@11d5960a326750d5838078e36cf38b85af677262/);
  assert.match(wf, /actions\/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020/);
  assert.match(wf, /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/);
  assert.match(wf, /\.\/\.github\/actions\/setup-claude/);

  // The wait + wrapper + upload steps must run even when the trunk dies.
  assert.match(wf, /- name: Wait for review\.json[\s\S]*?if: always\(\)/);
  assert.match(wf, /- name: Wrapper validate \/ synthesize[\s\S]*?if: always\(\)/);
  assert.match(wf, /- name: Upload artifacts[\s\S]*?if: always\(\)/);
});

test('every v2 shell script passes bash -n and is executable; mjs passes node --check', () => {
  const scripts = [
    'boot-session.sh', 'build-diff.sh', 'checkpoint.sh', 'checkpoint-watchdog.sh',
    'dispatch.sh', 'install-runner.sh', 'lib.sh', 'prepare-repo.sh',
    'restore-checkpoint.sh', 'shard-diff.sh', 'wait-review.sh', 'wrapper.sh',
  ];
  for (const s of scripts) {
    const p = path.join(v2, s);
    assert.ok(existsSync(p), `${s} missing`);
    execFileSync('bash', ['-n', p], { cwd: root, encoding: 'utf8' });
    const exec = execFileSync('bash', ['-c', `[ -x "$0" ] && echo yes`, p], { encoding: 'utf8' }).trim();
    assert.equal(exec, 'yes', `${s} not executable`);
  }
  for (const m of ['layout.mjs', 'evidence.mjs', 'checkpoint.mjs', 'validate-review.mjs']) {
    execFileSync('node', ['--check', path.join(harnessDir, m)], { cwd: root, encoding: 'utf8' });
  }
  execFileSync('node', ['--check', path.join(root, 'fake', 'worker.mjs')], { cwd: root, encoding: 'utf8' });
});

// -------------------------------------------------------------- checkpoint

test('checkpoint.sh delegates to the Node checkpoint (v2-checkpoint.1)', () => {
  const dir = tempDir('ckpt');
  mkdirSync(path.join(dir, 'evidence'), { recursive: true });
  writeFileSync(path.join(dir, 'evidence', 's-0.json'), JSON.stringify(validEvidence('s-0')));
  // invalid evidence (worker not ^W[0-9]{1,2}$) must be excluded by the scan.
  writeFileSync(path.join(dir, 'evidence', 's-1.json'), JSON.stringify(validEvidence('s-1', 'nope')));
  writeFileSync(path.join(dir, 'ledger.tsv'), [
    'worker\tassignment\tutc\tstatus',
    'W1\ts-0\t2026-08-08T00:00Z\tdispatched',
    '',
  ].join('\n'));

  const out = runScript(path.join(v2, 'checkpoint.sh'), { HARNESS_DIR: dir });
  assert.match(out, /checkpoint:/);

  const ckpt = JSON.parse(readFileSync(path.join(dir, 'checkpoint', 'checkpoint.json'), 'utf8'));
  assert.equal(ckpt.version, 'v2-checkpoint.1');
  assert.deepEqual(ckpt.completedAssignments, ['s-0']);
  assert.deepEqual(ckpt.key, { pullNumber: 1984, headOid: HEAD, enginePin: PIN });
  assert.equal(ckpt.runId, 'test-run-1');
  assert.match(ckpt.ledger, /worker\tassignment/);
  rmSync(dir, { recursive: true, force: true });
});

// ----------------------------------------------------------------- wrapper

test('wrapper.sh synthesizes infrastructure_failure when the trunk produced nothing', () => {
  const dir = tempDir('wrap');
  mkdirSync(path.join(dir, 'output'), { recursive: true });
  const out = runScript(path.join(v2, 'wrapper.sh'), { HARNESS_DIR: dir });
  const review = JSON.parse(readFileSync(path.join(dir, 'output', 'review.json'), 'utf8'));
  assert.match(out, /trunk/);
  assert.equal(review.version, 'v2r1');
  assert.equal(review.decision, 'infrastructure_failure');
  assert.equal(review.headOid, HEAD);
  assert.equal(review.failures.length, 1);
  assert.equal(review.failures[0].stage, 'trunk');
  assert.equal(review.failures[0].status, 'infra_error');
  rmSync(dir, { recursive: true, force: true });
});

test('wrapper.sh passes through a valid review.json and rejects bad ones', () => {
  const dir = tempDir('wrap');
  mkdirSync(path.join(dir, 'output'), { recursive: true });
  const reviewFile = path.join(dir, 'output', 'review.json');

  // approve with zero findings/failures is valid v2r1.
  writeFileSync(reviewFile, JSON.stringify({
    version: 'v2r1', decision: 'approve', headOid: HEAD,
    findings: [], failures: [], degradations: [], resumedFrom: null,
  }));
  runScript(path.join(v2, 'wrapper.sh'), { HARNESS_DIR: dir });
  assert.equal(JSON.parse(readFileSync(reviewFile, 'utf8')).decision, 'approve');

  // headOid mismatch -> validate fails -> parked + infra_failure.
  writeFileSync(reviewFile, JSON.stringify({
    version: 'v2r1', decision: 'approve', headOid: 'b'.repeat(40),
    findings: [], failures: [], degradations: [], resumedFrom: null,
  }));
  runScript(path.join(v2, 'wrapper.sh'), { HARNESS_DIR: dir });
  assert.equal(JSON.parse(readFileSync(reviewFile, 'utf8')).decision, 'infrastructure_failure');
  assert.ok(existsSync(path.join(dir, 'output', 'review.invalid.json')), 'mismatch doc not parked');

  // decision not in the enum -> parked + infra_failure.
  writeFileSync(reviewFile, JSON.stringify({
    version: 'v2r1', decision: 'banana', headOid: HEAD,
    findings: [], failures: [], degradations: [], resumedFrom: null,
  }));
  runScript(path.join(v2, 'wrapper.sh'), { HARNESS_DIR: dir });
  assert.equal(JSON.parse(readFileSync(reviewFile, 'utf8')).decision, 'infrastructure_failure');
  rmSync(dir, { recursive: true, force: true });
});

test('wrapper.sh rejects a finding whose evidence is not on disk (cross-check)', () => {
  const dir = tempDir('wrap');
  mkdirSync(path.join(dir, 'output'), { recursive: true });
  mkdirSync(path.join(dir, 'evidence'), { recursive: true });

  // Evidence on disk for s-0 only; the finding cites s-9 -> must be rejected.
  writeFileSync(path.join(dir, 'evidence', 's-0.json'), JSON.stringify(validEvidence('s-0')));
  const reviewFile = path.join(dir, 'output', 'review.json');
  writeFileSync(reviewFile, JSON.stringify({
    version: 'v2r1',
    decision: 'request_changes',
    headOid: HEAD,
    findings: [{
      taxonomy: 'correctness',
      path: 'src/x.mjs',
      line: 12,
      title: 'unused variable',
      evidence: {
        mode: 'test', commands: ['node --test'], artifacts: [], exitCodes: [0], assignmentId: 's-9',
      },
      rootCause: 'assignment to a dead variable',
      level: 'major',
      fingerprint: '0'.repeat(64),
    }],
    failures: [],
    degradations: [],
    resumedFrom: null,
  }));
  runScript(path.join(v2, 'wrapper.sh'), { HARNESS_DIR: dir });
  assert.equal(JSON.parse(readFileSync(reviewFile, 'utf8')).decision, 'infrastructure_failure');

  // Point the same finding at the completed s-0 evidence -> valid pass-through.
  // The bad doc was parked at review.invalid.json (review.json now holds the
  // synthesized infra_failure with no findings), so rebuild from the park.
  const parked = readFileSync(path.join(dir, 'output', 'review.invalid.json'), 'utf8');
  const validDoc = JSON.parse(parked.replace(/s-9/, 's-0'));
  writeFileSync(reviewFile, JSON.stringify(validDoc));
  runScript(path.join(v2, 'wrapper.sh'), { HARNESS_DIR: dir });
  assert.equal(JSON.parse(readFileSync(reviewFile, 'utf8')).decision, 'request_changes');
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- sharding

test('shard-diff.sh writes assignments under <root>/assignments/', () => {
  const dir = tempDir('shard');
  const diffPath = path.join(dir, 'diff.txt');
  writeFileSync(diffPath, [
    'diff --git a/scripts/foo.sh b/scripts/foo.sh',
    'index abc..def 100644',
    '--- a/scripts/foo.sh',
    '+++ b/scripts/foo.sh',
    '@@ -1 +1 @@',
    '-echo old',
    '+echo new',
    'diff --git a/Cargo.lock b/Cargo.lock',
    'index 111..222 100644',
    '--- a/Cargo.lock',
    '+++ b/Cargo.lock',
    '@@ -1 +1 @@',
    '-lock stuff',
    '+lock stuff 2',
    '',
  ].join('\n'));
  const out = runScript(path.join(v2, 'shard-diff.sh'), { HARNESS_DIR: dir, RV2_MAX_SHARD_CHARS: '12000' }, [diffPath]);
  assert.match(out, /shard-diff:/);
  const assignments = JSON.parse(readFileSync(path.join(dir, 'assignments', 'assignments.json'), 'utf8'));
  assert.equal(assignments.length, 2);
  assert.deepEqual(assignments.map((a) => [a.id, a.paths[0], a.kind]), [
    ['s-0', 'scripts/foo.sh', 'testable'],
    ['s-1', 'Cargo.lock', 'skip'],
  ]);
  rmSync(dir, { recursive: true, force: true });
});

// --------------------------------------------------------- fake worker loop

test('fake worker + checkpoint + wrapper run the full loop end to end', () => {
  const dir = tempDir('loop');
  mkdirSync(path.join(dir, 'output'), { recursive: true });
  mkdirSync(path.join(dir, 'directives'), { recursive: true });
  const env = harnessEnv(dir);

  const fake = spawn('node', [path.join(root, 'fake', 'worker.mjs'), 'W1'], { cwd: root, env, stdio: 'pipe' });
  const cleanup = () => { try { fake.kill('SIGKILL'); } catch {} };
  try {
    // Simulate the trunk dispatching two assignments (the directive file is
    // what dispatch.sh writes and the fake worker polls).
    writeFileSync(path.join(dir, 'directives', 'W1.md'), 'assignment s-0: exercise scripts/foo.sh at head');
    waitFor(() => existsSync(path.join(dir, 'evidence', 's-0.json')), 10000, 'evidence s-0');
    writeFileSync(path.join(dir, 'directives', 'W1.md'), 'assignment s-1: exercise scripts/bar.mjs at head');
    waitFor(() => existsSync(path.join(dir, 'evidence', 's-1.json')), 10000, 'evidence s-1');

    // checkpoint sees both.
    runScript(path.join(v2, 'checkpoint.sh'), { HARNESS_DIR: dir });
    const ckpt = JSON.parse(readFileSync(path.join(dir, 'checkpoint', 'checkpoint.json'), 'utf8'));
    assert.deepEqual(ckpt.completedAssignments, ['s-0', 's-1']);

    // A valid request_changes review citing s-0 evidence passes the wrapper.
    writeFileSync(path.join(dir, 'output', 'review.json'), JSON.stringify({
      version: 'v2r1',
      decision: 'request_changes',
      headOid: HEAD,
      findings: [{
        taxonomy: 'correctness',
        path: 'scripts/foo.sh',
        line: 1,
        title: 'echo portability',
        evidence: {
          mode: 'test', commands: ['sh scripts/foo.sh'], artifacts: [], exitCodes: [0], assignmentId: 's-0',
        },
        rootCause: 'the PR changed the shebang',
        level: 'minor',
        fingerprint: '1'.repeat(64),
      }],
      failures: [],
      degradations: [],
      resumedFrom: null,
    }));
    runScript(path.join(v2, 'wrapper.sh'), { HARNESS_DIR: dir });
    const review = JSON.parse(readFileSync(path.join(dir, 'output', 'review.json'), 'utf8'));
    assert.equal(review.decision, 'request_changes');
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  assert.fail(`timeout waiting for ${label}`);
}
