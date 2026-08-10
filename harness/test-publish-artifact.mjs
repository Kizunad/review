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
import { main, fitPublishedReview, renderMarkdown, MAX_MD_BYTES, MAX_JSON_BYTES } from './publish-artifact.mjs';
import { validateRunnerReview } from './validate-review.mjs';

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

// ---- the size caps are the gate's, so they are measured in the gate's unit ---
//
// write-finalize takes `wc -c < review.md -le 65536` and `wc -c < review.json
// -le 1048576`. Every assertion below counts BYTES for that reason; asserting on
// .length or on code points is exactly the mistake that let a Chinese verdict
// through the producer and into a red run with no comment on the pull request.
// wc -c counts the file including its trailing newline, so these read the file
// as a Buffer rather than as a decoded string.
async function fileBytes(file) {
  return (await readFile(file)).length;
}

// Text is only "not split" if it survives a UTF-8 round trip with no U+FFFD and
// no unpaired surrogate - the two shapes a byte-wise cut produces when it lands
// inside a character.
function intactUtf8(text) {
  if (text.includes('�')) return 'contains U+FFFD, a character was cut in half';
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)) {
    return 'contains an unpaired surrogate';
  }
  if (Buffer.from(text, 'utf8').toString('utf8') !== text) return 'does not survive a UTF-8 round trip';
  return '';
}

function gateAccepts(jsonText) {
  const file = join(tmpdir(), `rv2-gate-${Math.random().toString(36).slice(2)}.json`);
  try {
    execFileSync('sh', ['-c', 'cat > "$1"', 'sh', file], { input: jsonText });
    execFileSync('jq', ['-er', jqProgram, file], { encoding: 'utf8' });
    return '';
  } catch (error) {
    return String(error.stderr ?? error.message).trim() || 'rejected';
  }
}

// A verdict in the language this project's review policy is written in. Nothing
// here is exotic: 20 findings, each with a root cause a human would write.
function chineseRunner(count, { titlePad = '' } = {}) {
  return {
    version: 'v2r1',
    decision: 'request_changes',
    headOid: HEAD,
    findings: Array.from({ length: count }, (_, i) => ({
      taxonomy: 'concurrency',
      path: `server/src/mod${i}.rs`,
      line: 10 + i,
      title: `${titlePad}第${i}条:端口分配在两个测试套件同时启动时发生竞争`,
      evidence: {
        mode: 'test',
        commands: [`cargo test --lib mod${i} -- 中文说明${'详'.repeat(200)}`],
        artifacts: [`evidence/w1-s${i}/out.log`],
        exitCodes: [101],
        assignmentId: `w1-s${i}`,
      },
      rootCause: '端口分配器在绑定之前先检查空闲表,两个调用方于是观察到同一个空闲端口。'.repeat(24).slice(0, 1900),
      level: 'blocker',
      fingerprint: String(i % 10).repeat(64),
    })),
    failures: [],
    degradations: [],
    resumedFrom: null,
  };
}

{
  const runner = chineseRunner(20);
  if (!validateRunnerReview(runner).ok) bad('the Chinese fixture is not a valid v2r1 review - fix the fixture');
  const { dir } = await publish(runner);
  const md = await readFile(join(dir, 'review.md'), 'utf8');
  const bytes = await fileBytes(join(dir, 'review.md'));

  // The trap this fixture exists for: under the old code-point cap it measured
  // 25,623 code points - a third of 65536, so nothing truncated - and 68,343
  // bytes, which write-finalize rejects.
  if ([...md].length < MAX_MD_BYTES) {
    ok(`the Chinese verdict is under the cap in CODE POINTS (${[...md].length}), so a code-point cap cannot fire`);
  } else {
    bad('fixture no longer isolates the unit mismatch: it is over the cap in code points too');
  }
  if (bytes <= MAX_MD_BYTES) ok(`review.md is ${bytes} bytes, within the ${MAX_MD_BYTES}-byte gate check`);
  else bad(`review.md is ${bytes} bytes - write-finalize would kill the job with no comment on the PR`);

  if (md.includes('[truncated for the 65536-byte review.md limit]')) {
    ok('the truncated review.md says it was truncated');
  } else {
    bad('review.md was cut without saying so');
  }
  const damage = intactUtf8(md);
  if (damage) bad(`byte truncation split a character: ${damage}`);
  else ok('byte truncation of Chinese text left every character whole');

  const jsonBytes = await fileBytes(join(dir, 'review.json'));
  if (jsonBytes <= MAX_JSON_BYTES) ok(`review.json is ${jsonBytes} bytes, within ${MAX_JSON_BYTES}`);
  else bad(`review.json is ${jsonBytes} bytes`);
  const rejection = gateAccepts(await readFile(join(dir, 'review.json'), 'utf8'));
  if (rejection) bad(`the gate rejected the Chinese review.json: ${rejection}`);
  else ok('the gate accepts the Chinese review.json');
}

// A cut that lands INSIDE a four-byte sequence. All four byte alignments are
// exercised because which one you get depends on the padding ahead of the cut,
// and only one of them is the interesting case.
for (const pad of ['', 'x', 'xx', 'xxx']) {
  const runner = chineseRunner(20, { titlePad: pad });
  runner.findings.forEach((finding, i) => {
    finding.rootCause = `${'🧵'.repeat(600)} ${i}`;
  });
  const { dir } = await publish(runner);
  const md = await readFile(join(dir, 'review.md'), 'utf8');
  const bytes = await fileBytes(join(dir, 'review.md'));
  const damage = intactUtf8(md);
  if (bytes <= MAX_MD_BYTES && !damage) {
    ok(`astral characters survive the byte cut at alignment ${pad.length} (${bytes} bytes)`);
  } else {
    bad(`alignment ${pad.length}: ${bytes} bytes${damage ? `, ${damage}` : ''}`);
  }
}

// ---- review.json at its byte boundary, in pure ASCII ------------------------
//
// Nothing here is multi-byte. The runner's own validator says ok, and the
// published translation still came out at 1,132,849 bytes - the per-field caps
// simply multiply out past the file cap.
{
  const runner = {
    version: 'v2r1',
    decision: 'request_changes',
    headOid: HEAD,
    findings: Array.from({ length: 128 }, (_, i) => ({
      taxonomy: 'concurrency',
      path: `server/src/${'p'.repeat(400)}/mod${i}.rs`,
      line: 10 + i,
      title: `finding ${i} `.padEnd(180, 'T').slice(0, 180),
      evidence: {
        mode: 'test',
        commands: Array.from({ length: 4 }, (_, k) => `cargo test --lib mod${i}_${k} ${'y'.repeat(1450)}`),
        artifacts: [`evidence/w1-s${i}/out.log`],
        exitCodes: [101],
        assignmentId: `w1-s${i}`,
      },
      rootCause: `root ${i} `.padEnd(2000, 'R').slice(0, 2000),
      level: 'blocker',
      fingerprint: String(i % 10).repeat(64),
    })),
    failures: [],
    degradations: [],
    resumedFrom: null,
  };
  if (!validateRunnerReview(runner).ok) bad('the 128-finding fixture is not a valid v2r1 review - fix the fixture');

  const { dir, result } = await publish(runner);
  const bytes = await fileBytes(join(dir, 'review.json'));
  if (bytes <= MAX_JSON_BYTES) ok(`review.json is ${bytes} bytes, within the ${MAX_JSON_BYTES}-byte gate check`);
  else bad(`review.json is ${bytes} bytes - write-finalize would kill the job with no comment on the PR`);

  const published = JSON.parse(await readFile(join(dir, 'review.json'), 'utf8'));
  // Rung 1 clips derived evidence text; it must not have cost a whole finding,
  // because a dropped finding is a merge-gate fact that vanished.
  if (published.findings.length === 128 && result.dropped.findings === 0) {
    ok('fitting review.json clipped evidence and kept all 128 findings');
  } else {
    bad(`fitting review.json dropped ${result.dropped.findings} findings it did not have to`);
  }
  const rejection = gateAccepts(await readFile(join(dir, 'review.json'), 'utf8'));
  if (rejection) bad(`the gate rejected the fitted review.json: ${rejection}`);
  else ok('the gate accepts the fitted review.json - clipping did not break the schema');

  const md = await readFile(join(dir, 'review.md'), 'utf8');
  if (md.includes('was reduced to fit') && md.includes('evidence clipped to')) {
    ok('review.md - the comment on the PR - says review.json was reduced');
  } else {
    bad('review.json was reduced and only the job log knows');
  }
  // The notice has to be ahead of the findings, because review.md is cut from
  // the tail and this fixture is big enough to be cut.
  if (md.indexOf('was reduced to fit') < md.indexOf('### Findings')) {
    ok('the reduction notice sits above the findings, where the review.md cut cannot reach it');
  } else {
    bad('the reduction notice is below the findings and would be truncated away');
  }
  const mdBytes = await fileBytes(join(dir, 'review.md'));
  if (mdBytes <= MAX_MD_BYTES) ok(`review.md is ${mdBytes} bytes`);
  else bad(`review.md is ${mdBytes} bytes`);
}

// ---- one chatty finding must not evict every finding after it ---------------
//
// evidence.commands is 64 entries x 2000 characters at the schema limit =
// 128,000 characters for a single finding, twice the whole review.md budget.
// Rendered raw, the fixture below published finding #0 and nothing else.
{
  const runner = runnerReview();
  const chatty = JSON.parse(JSON.stringify(runner.findings[0]));
  chatty.evidence.commands = Array.from({ length: 64 }, (_, k) => `cargo test --lib case${k} ${'z'.repeat(1950)}`);
  runner.findings = [chatty, ...Array.from({ length: 5 }, (_, i) => {
    const finding = JSON.parse(JSON.stringify(runner.findings[0]));
    finding.title = `quiet finding ${i}`;
    finding.line = 200 + i;
    finding.fingerprint = String(i).repeat(64);
    return finding;
  })];
  if (!validateRunnerReview(runner).ok) bad('the chatty-commands fixture is not a valid v2r1 review - fix the fixture');

  const { dir } = await publish(runner);
  const md = await readFile(join(dir, 'review.md'), 'utf8');
  const rendered = (md.match(/^#### /gm) || []).length;
  if (rendered === 6) ok('all six findings reach review.md despite one at the commands limit');
  else bad(`only ${rendered} of 6 findings reached review.md - one finding ate the budget`);
  const bytes = await fileBytes(join(dir, 'review.md'));
  if (bytes <= MAX_MD_BYTES) ok(`review.md is ${bytes} bytes with a commands block at the limit`);
  else bad(`review.md is ${bytes} bytes`);
}

// ---- when even clipping is not enough, drop - but stay publishable ----------
//
// Driven through fitPublishedReview's cap argument rather than a megabyte
// fixture: the rung under test is "the file still does not fit", and what that
// must never produce is a review.json the gate's jq rejects. request_changes
// with zero findings is such a review.
{
  const runner = chineseRunner(20);
  const { text, dropped } = fitPublishedReview(runner, 8000);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= 8000 && dropped.findings > 0) {
    ok(`dropping fits an 8000-byte cap (${bytes} bytes, ${dropped.findings} findings dropped)`);
  } else {
    bad(`fitPublishedReview produced ${bytes} bytes for an 8000-byte cap, dropped ${dropped.findings}`);
  }
  const parsed = JSON.parse(text);
  if (parsed.findings.length >= 1) ok('request_changes keeps at least one finding, as its decision invariant requires');
  else bad('dropping emptied a request_changes review - the gate would reject it');
  const rejection = gateAccepts(text);
  if (rejection) bad(`the gate rejected the dropped-down review.json: ${rejection}`);
  else ok('the gate accepts review.json after findings were dropped');
  const md = renderMarkdown(runner, { repository: 'Kizunad/Bong', pullNumber: 2030, runId: '1', dropped });
  if (md.includes('finding(s) dropped from the end')) ok('review.md names the dropped findings');
  else bad('findings were dropped silently');
}
{
  const runner = {
    ...chineseRunner(0),
    decision: 'infrastructure_failure',
    failures: Array.from({ length: 512 }, (_, i) => ({
      stage: `阶段${i}`,
      status: 'infra_error',
      error: `第${i}次尝试:trunk 进程在写出判词之前退出。`.repeat(80).slice(0, 3900),
      diagnostic: `诊断:该 assignment 的证据目录为空。`.repeat(120).slice(0, 3900),
    })),
  };
  if (!validateRunnerReview(runner).ok) bad('the 512-failure fixture is not a valid v2r1 review - fix the fixture');
  const { text, dropped } = fitPublishedReview(runner);
  const bytes = Buffer.byteLength(text, 'utf8');
  const parsed = JSON.parse(text);
  if (bytes <= MAX_JSON_BYTES && dropped.failures > 0 && parsed.failures.length >= 1) {
    ok(`512 Chinese failures fit in ${bytes} bytes, ${dropped.failures} dropped, invariant intact`);
  } else {
    bad(`512-failure review: ${bytes} bytes, ${dropped.failures} dropped, ${parsed.failures.length} kept`);
  }
  const rejection = gateAccepts(text);
  if (rejection) bad(`the gate rejected the dropped-down infrastructure_failure: ${rejection}`);
  else ok('the gate accepts infrastructure_failure after failures were dropped');
  const md = renderMarkdown(runner, { repository: 'Kizunad/Bong', pullNumber: 2030, runId: '1', dropped });
  if (md.includes('failure(s) dropped from the end') && !md.includes('per finding')) {
    ok('review.md names the dropped failures and does not claim to have clipped evidence it has none of');
  } else {
    bad('the infrastructure_failure notice is missing or describes findings that do not exist');
  }
}
{
  // Below the irreducible minimum there is nothing left to give up. Throwing
  // here writes no artifact, which makes write-finalize take the
  // missing-artifact handoff and comment - degraded, but still a comment.
  let threw = '';
  try { fitPublishedReview(chineseRunner(20), 100); } catch (error) { threw = error.message; }
  if (threw.includes('smallest publishable shape')) {
    ok('an impossible cap fails loudly here rather than shipping an oversize artifact');
  } else {
    bad(`expected a refusal at the irreducible minimum, got: ${threw || '<no error>'}`);
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
