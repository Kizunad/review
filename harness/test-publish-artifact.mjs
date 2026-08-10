// Does the translated artifact pass the ACTUAL merge gate?
//
// Not a restatement of the gate - the gate. The jq program is extracted from
// review.yml at test time and the manifest is checked with verifyManifest() from
// src/, so neither can drift away from what the finalize job runs without this
// failing. A test that re-implements the contract it is testing only proves the
// two copies agree with each other.
//
// Usage: node harness/test-publish-artifact.mjs
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { verifyManifest } from '../src/artifact-manifest.mjs';
import { main } from './publish-artifact.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

let fails = 0;
const ok = (m) => console.log(`ok   - ${m}`);
const bad = (m) => { console.log(`FAIL - ${m}`); fails += 1; };

// Pull the gate's own jq program out of the workflow. If the shape of that step
// changes, this throws instead of quietly testing nothing.
async function gateJqProgram() {
  const yml = await readFile(join(REPO, '.github/workflows/review.yml'), 'utf8');
  const start = yml.indexOf(`decision="$(jq -er '`);
  if (start < 0) throw new Error('could not find the gate jq program in review.yml');
  const from = start + `decision="$(jq -er '`.length;
  const end = yml.indexOf(`' _review/review.json)`, from);
  if (end < 0) throw new Error('could not find the end of the gate jq program in review.yml');
  const program = yml.slice(from, end);
  if (program.length < 500) throw new Error('extracted jq program is implausibly short');
  return program;
}

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);

function runnerReview(overrides = {}) {
  return {
    version: 'v2r1',
    decision: 'request_changes',
    headOid: HEAD,
    findings: [{
      taxonomy: 'concurrency',
      path: 'server/src/bot.rs',
      line: 142,
      title: 'port allocation races when two suites start together',
      evidence: {
        mode: 'test',
        commands: ['cargo test --lib bot::port_alloc -- --test-threads=2', 'BONG_SERVER_PORT=0 ./target/debug/bong-server'],
        artifacts: ['evidence/w1-s1/out.log'],
        exitCodes: [101, 0],
        assignmentId: 'w1-s1',
      },
      rootCause: 'the allocator checks the port free list before binding, so two callers observe the same free port',
      level: 'blocker',
      fingerprint: 'c'.repeat(64),
    }],
    failures: [],
    degradations: [{ at: '2026-08-10T10:00:00Z', from: 'probe', to: 'test', reason: 'binary unavailable' }],
    resumedFrom: null,
    ...overrides,
  };
}

async function publish(runner, env = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rv2-pub-'));
  const source = join(dir, 'runner.json');
  await writeFile(source, JSON.stringify(runner));
  const previous = { ...process.env };
  Object.assign(process.env, {
    REPOSITORY: 'Kizunad/Bong',
    PULL_NUMBER: '2030',
    BASE_OID: BASE,
    HEAD_OID: HEAD,
    RUN_ID: '31376928375',
    RUN_ATTEMPT: '1',
    WORKFLOW_REF: 'd'.repeat(40),
    POLICY_SHA256: 'e'.repeat(64),
    ...env,
  });
  try {
    const result = await main([source, join(dir, 'out')]);
    return { dir: join(dir, 'out'), result };
  } finally {
    process.env = previous;
  }
}

const jqProgram = await gateJqProgram();
ok(`extracted the gate jq program from review.yml (${jqProgram.length} chars)`);

// ---- the happy path, checked by the gate itself -----------------------------
{
  const { dir } = await publish(runnerReview());
  let decision = '';
  try {
    decision = execFileSync('jq', ['-er', jqProgram, join(dir, 'review.json')], { encoding: 'utf8' }).trim();
  } catch (error) {
    bad(`the gate rejected the translated review.json: ${String(error.stderr ?? error.message).trim()}`);
  }
  if (decision === '"request_changes"' || decision === 'request_changes') {
    ok('the gate accepts the translated review.json and reads decision=request_changes');
  } else if (decision) {
    bad(`gate returned an unexpected decision: ${decision}`);
  }

  const artifacts = {
    'review.json': await readFile(join(dir, 'review.json'), 'utf8'),
    'review.md': await readFile(join(dir, 'review.md'), 'utf8'),
  };
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  try {
    verifyManifest(manifest,
      { repository: 'Kizunad/Bong', pullNumber: 2030, baseOid: BASE, headOid: HEAD },
      artifacts,
      { runId: '31376928375', runAttempt: '1', workflowRef: 'd'.repeat(40), policySha256: 'e'.repeat(64) });
    ok('verifyManifest accepts the manifest, hashes and binding');
  } catch (error) {
    bad(`verifyManifest rejected it: ${error.message}`);
  }

  // The measured evidence must survive into something a human reads.
  const md = artifacts['review.md'];
  if (md.includes('cargo test --lib bot::port_alloc') && md.includes('exit 101,0')) {
    ok('review.md carries the commands and exit codes the published schema cannot');
  } else {
    bad('review.md lost the measured evidence');
  }
  if (md.includes('probe → test') && md.includes('binary unavailable')) {
    ok('review.md carries the degradation the published schema cannot');
  } else {
    bad('review.md lost the degradation - a degraded review would look identical to a clean one');
  }
}

// ---- infrastructure_failure ------------------------------------------------
{
  const runner = runnerReview({
    decision: 'infrastructure_failure',
    findings: [],
    degradations: [],
    failures: [{ stage: 'trunk', status: 'infra_error', error: 'trunk produced no review.json' }],
  });
  const { dir } = await publish(runner);
  try {
    execFileSync('jq', ['-er', jqProgram, join(dir, 'review.json')], { encoding: 'utf8' });
    ok('the gate accepts a translated infrastructure_failure');
  } catch (error) {
    bad(`gate rejected infrastructure_failure: ${String(error.stderr ?? error.message).trim()}`);
  }
}

// ---- approve with only minor findings --------------------------------------
{
  const runner = runnerReview({ decision: 'approve' });
  runner.findings[0].level = 'minor';
  const { dir } = await publish(runner);
  try {
    execFileSync('jq', ['-er', jqProgram, join(dir, 'review.json')], { encoding: 'utf8' });
    ok('the gate accepts a translated approve carrying a minor finding');
  } catch (error) {
    bad(`gate rejected approve: ${String(error.stderr ?? error.message).trim()}`);
  }
}

// ---- refusals: the two ways this could publish a lie ------------------------
{
  let threw = '';
  try {
    await publish(runnerReview({ headOid: 'f'.repeat(40) }));
  } catch (error) { threw = error.message; }
  if (threw.includes('but the PR head is')) {
    ok('refuses to publish a review of a different commit than the PR head');
  } else {
    bad(`expected a head mismatch refusal, got: ${threw || '<no error>'}`);
  }
}
{
  let threw = '';
  try {
    // request_changes with zero findings is invalid v2r1 AND invalid at the gate.
    await publish(runnerReview({ findings: [] }));
  } catch (error) { threw = error.message; }
  if (threw.includes('not valid v2r1')) {
    ok('refuses an invalid runner review here, naming v2r1, instead of four steps later');
  } else {
    bad(`expected a v2r1 validation refusal, got: ${threw || '<no error>'}`);
  }
}

// ---- determinism: same input, same hashes ----------------------------------
{
  const a = await publish(runnerReview());
  const b = await publish(runnerReview());
  const ha = JSON.parse(await readFile(join(a.dir, 'manifest.json'), 'utf8')).manifestSha256;
  const hb = JSON.parse(await readFile(join(b.dir, 'manifest.json'), 'utf8')).manifestSha256;
  if (ha === hb) ok('the same review produces the same manifest hash');
  else bad('manifest hash is not deterministic - the gate would reject on a re-run');
  await rm(a.dir, { recursive: true, force: true });
  await rm(b.dir, { recursive: true, force: true });
}

console.log('');
if (fails === 0) { console.log('test-publish-artifact: PASS'); process.exit(0); }
console.log(`test-publish-artifact: ${fails} FAILED`);
process.exit(1);
