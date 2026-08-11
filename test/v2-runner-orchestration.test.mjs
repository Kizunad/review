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
    'Install runner harness (tmux + jq)',
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
  // ENGINE_PIN comes from the preflight job's resolution, NOT from github.sha. This assertion
  // used to demand github.sha and was wrong in the mode that matters: under workflow_call
  // github.sha is the CALLER's commit, so a resume key built from it names Bong's HEAD as the
  // engine pin. The workflow says so in a comment and the test still asserted the old value -
  // a red test that everyone learns to scroll past is worse than no test.
  assert.match(wf, /ENGINE_PIN:\s*\$\{\{ needs\.preflight\.outputs\.engine_ref \}\}/);
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

// The breaker is caller-visible behaviour that only shows up during an outage, which is the
// worst time to discover it was silently un-wired by an edit to a `needs:` line. v1 guards its
// copy the same way in workflow-static.test.mjs; this is the v2 half.
test('review-v2-p1.yml gates every expensive job behind the shared infrastructure circuit', () => {
  const wf = readFileSync(path.join(root, '.github/workflows/review-v2-p1.yml'), 'utf8');
  const section = (name, next) => {
    const match = wf.match(new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)${next ? `\\n  ${next}:\\n` : '$'}`));
    assert.ok(match, `job ${name} must be extractable`);
    return match[1];
  };
  const preflight = section('preflight', 'build-server');
  const build = section('build-server', 'review');
  const review = section('review', 'write-finalize');
  const finalize = section('write-finalize');

  // ONE implementation, shared with v1. A second copy of the sliding-window arithmetic is a
  // second thing to keep in step, and the two would only be discovered to disagree during the
  // outage they both exist for.
  assert.match(preflight, /node src\/run-circuit\.mjs preflight/);
  assert.match(finalize, /node _central\/src\/run-circuit\.mjs skip-comment/);
  assert.match(finalize, /node _central\/src\/run-circuit\.mjs record/);
  // Comments stripped first: the workflow is entitled to NAME circuit-store.mjs when it
  // explains where the state lives. What must not appear is a call into it, or a second
  // sliding-window computed in bash or jq.
  const executable = wf.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
  assert.doesNotMatch(executable, /evaluateCircuit|parseTrustedCircuitEvents|circuit-store/);

  // Read-only, and it never speaks on the pull request: the skip notice belongs to the one job
  // that has write permission.
  assert.match(preflight, /circuit_should_run: \$\{\{ steps\.circuit\.outputs\.should_run \}\}/);
  assert.match(preflight, /circuit_open_until: \$\{\{ steps\.circuit\.outputs\.open_until \}\}/);
  assert.doesNotMatch(preflight, /pull-requests: write|issues: write|skip-comment/);

  // Every job that costs money is behind the breaker - the 45-minute build included, since it
  // is the single largest piece of what an open circuit is saving.
  for (const [name, job] of [['build-server', build], ['review', review]]) {
    assert.match(job, /needs\.preflight\.outputs\.circuit_should_run == 'true'/,
      `${name} must not start while the circuit is open`);
  }

  // A skip is announced and then fails the check. Silence, or worse a green check, would let
  // branch protection read "no review attempted" as "approved".
  assert.match(finalize, /Publish the circuit skip notice[\s\S]*?circuit_should_run == 'false'/);
  assert.match(finalize, /Preserve the circuit skip as a non-verdict failure[\s\S]*?circuit_should_run == 'false'/);

  // What may and may not enter the count. A request_changes is a verdict and a moved head is a
  // refusal; neither is an outage, and three of either must never open the breaker.
  const record = finalize.match(/Record the infrastructure failure in the caller circuit([\s\S]*?)\n      - name: /);
  assert.ok(record, 'the circuit record step must be extractable');
  assert.match(record[1], /steps\.publish\.outputs\.decision == 'infrastructure_failure'/);
  assert.match(record[1], /steps\.publish\.outputs\.stale_head != 'true'/);
  assert.doesNotMatch(record[1], /request_changes/);
  assert.match(finalize, /printf 'stale_head=true\\n' >> "\$GITHUB_OUTPUT"/);

  // The breaker's numbers exist once. v1 repeats them in two jobs with nothing linking the
  // copies, so a preflight opening at 3-in-60 can coexist with a record step counting some
  // other rule.
  for (const key of ['CIRCUIT_THRESHOLD', 'CIRCUIT_WINDOW_MINUTES', 'CIRCUIT_DURATION_MINUTES']) {
    assert.equal(wf.split(`${key}:`).length - 1, 1, `${key} must be configured in exactly one place`);
  }
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
  mkdirSync(path.join(dir, 'evidence'), { recursive: true });
  mkdirSync(path.join(dir, 'assignments'), { recursive: true });
  const reviewFile = path.join(dir, 'output', 'review.json');

  // The fixture now needs an assignment and a PASSING evidence file, because an approve no
  // longer stands on an empty harness directory - see v2/test-approve-guard.sh and Bong run
  // 31456996236, where two shards reported verdict=blocked and the trunk approved anyway.
  // This test is about VALIDATION, so it supplies the sufficiency the guard requires and keeps
  // testing the thing it is named for. The two invalid cases below never reach the guard: they
  // fail v2r1 validation first.
  writeFileSync(path.join(dir, 'assignments', 'assignments.json'),
    JSON.stringify([{ id: 's-0', paths: ['a.py'], chars: 10, kind: 'testable' }]));
  writeFileSync(path.join(dir, 'evidence', 's-0.json'), JSON.stringify(validEvidence('s-0')));

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

test('every variable the agent prompts reference is actually provided to the panes', () => {
  // The prompts are executable instructions, not prose: trunk-prompt.md tells the
  // trunk to run "$V2_DIR/shard-diff.sh", ". $V2_DIR/lib.sh", "$V2_DIR/dispatch.sh".
  // A referenced variable that nobody sets does not error - it expands to empty, so
  // "$V2_DIR/shard-diff.sh" becomes "/shard-diff.sh" and the trunk simply achieves
  // nothing. That is the least diagnosable failure this harness has, and V2_DIR was
  // in exactly that state: known to boot-session.sh as a local, never exported, while
  // five commands in the prompt depended on it.
  //
  // Three legitimate providers, because the values become known at three different
  // times: the workflow job env (static), a step writing to $GITHUB_ENV (known after
  // the build job), and boot-session.sh exporting into the pane (known only at
  // runtime from $0). The test does not care which - only that there is one.
  const wf = readFileSync(path.join(root, '.github/workflows/review-v2-p1.yml'), 'utf8');
  const boot = readFileSync(path.join(root, 'v2/boot-session.sh'), 'utf8');
  const prompts = ['v2/trunk-prompt.md', 'v2/worker-brief.md']
    .map((p) => readFileSync(path.join(root, p), 'utf8')).join('\n');

  const referenced = [...new Set([...prompts.matchAll(/\$([A-Z][A-Z0-9_]{2,})/g)].map((m) => m[1]))];
  assert.ok(referenced.includes('V2_DIR'), 'guard self-check: the prompts must reference V2_DIR');
  assert.ok(referenced.length >= 5, `guard self-check: expected several referenced vars, got ${referenced.length}`);

  // THE THREE PROBES BELOW WERE ALL WRONG, IN BOTH DIRECTIONS, AND THE GUARD STILL "WORKED".
  //
  // exportedToPane was /export\s+NAME=/. boot-session.sh exports several variables in one
  // statement - `export HOME='...' V2_DIR='...'` - so `export` is followed by `HOME=` and the
  // regex missed every variable but the first. This test therefore FAILED on V2_DIR while
  // V2_DIR was correctly exported: the guard written to catch the V2_DIR bug fired on the fix
  // for the V2_DIR bug. A false alarm here is not harmless - it is what teaches the next person
  // to add a name to an allowlist instead of reading the code.
  //
  // viaGithubEnv was `new RegExp(`${name}=`).test(wf) && /GITHUB_ENV/.test(wf)`. The right
  // conjunct is a CONSTANT TRUE - the workflow mentions GITHUB_ENV somewhere, always. The left
  // was unanchored, so it matched a comment, and matched inside a longer name: `HEAD_OID=`
  // matches within `RV2_HEAD_OID=`, so HEAD_OID scored "provided" with nothing providing it.
  // Between them the check answered "is this string somewhere in the file", not "is this
  // variable set" - so a variable added to a prompt and never plumbed would pass, which is the
  // single thing this test exists to prevent.
  // A name is "provided" only through one of the three mechanisms that actually exist, each
  // matched as it is really written - not by appearing somewhere in a file.
  //
  // Widening a probe until the suite goes green is the failure mode here, so the widening is
  // bounded by the self-checks below: a name nobody sets must still come back unprovided. That
  // assertion is what separates "the probes model the code" from "the probes match anything".
  const word = (name) => new RegExp(`(?<![A-Z0-9_])${name}=`);
  const wfLines = wf.split('\n');
  const bootLines = boot.replace(/\\\n/g, ' ').split('\n');

  const isProvided = (name) => {
    // 1. static job env: `      NAME: value`
    if (new RegExp(`^\\s{6}${name}:`, 'm').test(wf)) return true;
    // 2. written to $GITHUB_ENV. The redirect is often a BLOCK redirect several lines below the
    //    printf that names the variable, so look ahead a little - but only to a redirect, never
    //    to the mere mention of GITHUB_ENV anywhere in the file (that was the constant-true bug).
    for (let i = 0; i < wfLines.length; i += 1) {
      if (!word(name).test(wfLines[i])) continue;
      if (/GITHUB_ENV/.test(wfLines[i])) return true;
      for (let j = i + 1; j < Math.min(i + 10, wfLines.length); j += 1) {
        if (/>>\s*"?\$\{?GITHUB_ENV\}?"?/.test(wfLines[j])) return true;
        if (/^\s*-\s+name:/.test(wfLines[j])) break;   // next step - stop looking
      }
    }
    // 3. exported into the pane by boot-session.sh, either directly on an `export` statement or
    //    accumulated into PANE_ENV, which is what the pane launch line exports.
    return bootLines.some((l) => word(name).test(l)
      && (/(^|[;&|]|\s)export\s/.test(l) || /PANE_ENV=/.test(l)));
  };

  const unprovided = referenced.filter((name) => !isProvided(name));

  // Probe self-checks. Each names the exact defect it prevents.
  assert.ok(isProvided('V2_DIR'),
    'probe self-check: V2_DIR is exported by boot-session.sh and must be seen as provided '
    + '(a probe that misses it fires on the fix for the bug it was written to catch)');
  assert.ok(!isProvided('RV2_NOTHING_SETS_THIS'),
    'probe self-check: a variable nobody sets must still come back UNPROVIDED - without this '
    + 'the probes can widen until nothing can ever fail, which is the same as deleting the test');
  assert.ok(!word('HEAD_OID').test('RV2_HEAD_OID=x'),
    'probe self-check: a short name must not match inside a longer one');
  assert.deepEqual(unprovided, [],
    `these are referenced by the prompts but set by nobody, so they expand to empty: ${unprovided.join(', ')}`);
});

test('the review timeout leaves room for the wrapper and the upload inside the job timeout', () => {
  // Two numbers in two files with no link between them. If wait-review's timeout
  // ever exceeds the job's, GitHub kills the job first - and a job killed by
  // GitHub produces NO synthesized review.json and NO artifact, which is
  // strictly worse than a clean infrastructure_failure. The wrapper and the
  // upload are `if: always()` steps that still have to run after the wait
  // expires, so the gap is a requirement, not slack.
  const wf = readFileSync(path.join(root, '.github/workflows/review-v2-p1.yml'), 'utf8');
  const wait = readFileSync(path.join(root, 'v2/wait-review.sh'), 'utf8');

  const reviewJob = wf.slice(wf.indexOf('\n  review:'));
  const jobMinutes = Number(/timeout-minutes:\s*(\d+)/.exec(reviewJob)?.[1]);
  const waitSeconds = Number(/RV2_REVIEW_TIMEOUT_S:-(\d+)/.exec(wait)?.[1]);
  assert.ok(Number.isInteger(jobMinutes) && jobMinutes > 0, 'could not read the review job timeout');
  assert.ok(Number.isInteger(waitSeconds) && waitSeconds > 0, 'could not read the wait-review default');

  const RESERVE_S = 300;
  assert.ok(waitSeconds + RESERVE_S <= jobMinutes * 60,
    `wait-review default ${waitSeconds}s + ${RESERVE_S}s for wrapper/upload exceeds the ${jobMinutes}m job timeout`);
  // The other direction is not a correctness bug but it is waste worth naming:
  // 1500s against a 60m job left 35 minutes of paid runner unused, sized for a
  // test-only mode that no longer exists now that probe builds and deploys.
  assert.ok(waitSeconds >= jobMinutes * 60 * 0.6,
    `wait-review default ${waitSeconds}s uses under 60% of the ${jobMinutes}m job - probe runs need the room`);
});

function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  assert.fail(`timeout waiting for ${label}`);
}


// setup_command exists so the crew can reach a toolchain the engine does not know about, and
// its ORDERING is the safety property, not a detail.
//
// 2026-08-11: across two complete runs, six shards, the crew invoked python3 and nothing else -
// because both runs reviewed a Python-only PR. So Rust and Java were never "broken", they were
// never ATTEMPTED, and the review job installs only Node, Claude Code, tmux and jq. Bong's own
// e2e.yml sets up dtolnay/rust-toolchain and actions/setup-java explicitly, which is the tell
// that the runner image's defaults are not what its tests actually run on.
//
// The step must run BEFORE the reviewed head is on disk. A setup command that executes after
// `Prepare repo under review` could be pointed at a script inside the PR - `bash
// scripts/ci-setup.sh` - and would then run attacker-controlled code with a caller's trust
// level. Ordering is what makes that impossible rather than merely discouraged, and ordering is
// exactly the kind of property that survives review and then quietly dies in a later edit.
test('caller toolchain setup runs before the reviewed repo is on disk', () => {
  const wf = readFileSync(path.join(root, '.github/workflows/review-v2-p1.yml'), 'utf8');
  const setupAt = wf.indexOf('- name: Caller toolchain setup');
  const prepAt = wf.indexOf('- name: Prepare repo under review');
  assert.ok(setupAt > 0, 'the Caller toolchain setup step must exist');
  assert.ok(prepAt > 0, 'Prepare repo under review must exist');
  assert.ok(
    setupAt < prepAt,
    'setup_command must run BEFORE the reviewed head is checked out, or it can execute code from the PR',
  );
  // Gated, so a caller that supplies nothing does not get an empty bash -c.
  const step = wf.slice(setupAt, prepAt);
  assert.match(step, /if:\s*inputs\.setup_command != ''/);
  // Passed through the environment, never interpolated into the script body: an expression
  // expanded inline is a shell injection from whatever the caller wrote, and the caller's
  // workflow file is trusted but its VARIABLES may not be.
  assert.match(step, /SETUP_COMMAND:\s*\$\{\{ inputs\.setup_command \}\}/);
  assert.match(step, /bash -eo pipefail -c "\$SETUP_COMMAND"/);
  assert.doesNotMatch(step, /run:[\s\S]*\$\{\{ inputs\.setup_command \}\}/);
});

// Declared under workflow_call only, a trial could never reach it - the same hole that kept
// probe mode unreachable until build_command was mirrored into dispatch.
test('setup_command is reachable from both call shapes', () => {
  const wf = readFileSync(path.join(root, '.github/workflows/review-v2-p1.yml'), 'utf8');
  const call = wf.slice(wf.indexOf('  workflow_call:'), wf.indexOf('  workflow_dispatch:'));
  const dispatch = wf.slice(wf.indexOf('  workflow_dispatch:'), wf.indexOf('\njobs:'));
  assert.match(call, /setup_command:/, 'workflow_call must declare setup_command');
  assert.match(dispatch, /setup_command:/, 'workflow_dispatch must mirror it or trials cannot use it');
});
