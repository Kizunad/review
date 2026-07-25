import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { executeReview, renderReviewMarkdown } from '../src/review-entry.mjs';

const policy = {
  version: 'project-review-policy.v1',
  project: 'org/repo',
  rules: [{ id: 'canonical-contract', severity: 'major', text: 'Keep the canonical contract connected end to end.' }],
  minorFindingsRequestChanges: true,
};

const policySha256 = createHash('sha256').update(JSON.stringify(policy)).digest('hex');

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'review-entry-'));
  const callerRoot = path.join(root, 'caller');
  await mkdir(callerRoot);
  await mkdir(path.join(callerRoot, '.claude'));
  await writeFile(path.join(callerRoot, '.claude', 'settings.json'), '{"hooks":{"SessionStart":[]}}');
  await writeFile(path.join(callerRoot, '.mcp.json'), '{"mcpServers":{"attacker":{"command":"false"}}}');
  await writeFile(path.join(callerRoot, 'CLAUDE.md'), 'untrusted instructions');
  await mkdir(path.join(callerRoot, 'src'));
  await writeFile(path.join(callerRoot, 'src', 'a.mjs'), 'export const changed = true;\n');
  const callsPath = path.join(root, 'calls.jsonl');
  const executable = path.join(root, 'fake-claude.mjs');
  await writeFile(executable, `#!/usr/bin/env node
import { access, appendFile } from 'node:fs/promises';
const args = process.argv.slice(2);
const prompt = args[args.indexOf('-p') + 1];
const model = args[args.indexOf('--model') + 1];
async function exists(target) { try { await access(target); return true; } catch { return false; } }
const entry = {
  model,
  prompt,
  cwd: process.cwd(),
  args,
  home: process.env.HOME,
  projectConfigPresent: await exists('.claude/settings.json') || await exists('.mcp.json') || await exists('CLAUDE.md'),
  sourcePresent: await exists('src/a.mjs'),
};
await appendFile(${JSON.stringify(callsPath)}, JSON.stringify(entry) + '\\n');
let output;
if (prompt.includes('fresh Sol planner')) output = { version: 'v1', assignments: [{ id: 'all', shardIndexes: [0] }] };
else if (prompt.includes('fresh Luna summarizer')) output = { version: 'v1', summary: 'one changed file', files: ['src/a.mjs'] };
else if (prompt.includes('fresh Terra finder')) output = [];
else throw new Error('unexpected stage');
process.stdout.write(JSON.stringify({ type: 'result', structured_output: output }));
`);
  await (await import('node:fs/promises')).chmod(executable, 0o755);
  return { root, callerRoot, callsPath, executable };
}

test('executes fresh Sol, Luna, and one Terra finder per taxonomy dimension', async () => {
  const { callerRoot, callsPath, executable } = await fixture();
  const result = await executeReview({
    centralRoot: path.resolve('.'),
    callerRoot,
    repository: 'org/repo',
    diff: 'diff --git a/src/a.mjs b/src/a.mjs\n+changed\n',
    policy,
    policySha256,
    executable,
    environment: { PATH: process.env.PATH, CALLS_PATH: callsPath, REVIEW_HEAD_OID: 'a'.repeat(40) },
  });
  assert.equal(result.review.decision, 'approve');
  assert.deepEqual(result.review.findings, []);
  const calls = (await (await import('node:fs/promises')).readFile(callsPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter((call) => call.model === 'sol').length, 1);
  assert.equal(calls.filter((call) => call.model === 'luna').length, 1);
  assert.equal(calls.filter((call) => call.model === 'terra').length, 8);
  assert.ok(calls.every((call) => call.cwd !== callerRoot));
  assert.equal(new Set(calls.map((call) => call.cwd)).size, 1);
  assert.ok(calls.every((call) => call.projectConfigPresent === false));
  assert.ok(calls.every((call) => call.sourcePresent === true));
  assert.ok(calls.every((call) => call.home !== process.env.HOME));
  const sanitizedRoot = calls[0].cwd;
  await assert.rejects(access(sanitizedRoot));
  assert.ok(calls.every((call) => call.args.includes('--no-session-persistence')));
  assert.ok(calls.every((call) => call.args.includes('Read,Glob,Grep')));
  const finders = calls.filter((call) => call.prompt.includes('fresh Terra finder'));
  assert.ok(finders.every((call) => !call.prompt.includes('fresh Sol planner')));
  assert.ok(finders.some((call) => call.prompt.includes('/code-review')));
});

test('rejects oversized diffs and malformed project policies before spawning Claude', async () => {
  const { callerRoot, executable } = await fixture();
  await assert.rejects(() => executeReview({
    centralRoot: path.resolve('.'), callerRoot, repository: 'org/repo', diff: '12345', policy, policySha256, executable,
    maxDiffChars: 4, environment: { PATH: process.env.PATH },
  }), /diff exceeds/);
  await assert.rejects(() => executeReview({
    centralRoot: path.resolve('.'), callerRoot, repository: 'org/repo', diff: '', policy: { ...policy, project: 'other/repo' }, policySha256, executable,
    environment: { PATH: process.env.PATH },
  }), /project/);
});

test('renders infrastructure failures without implying a code verdict', () => {
  const markdown = renderReviewMarkdown({
    version: 'v1', decision: 'infrastructure_failure', findings: [],
    failures: [{ stage: 'validate:x', status: 'infra_error', error: 'five votes unavailable' }],
  }, { headOid: 'b'.repeat(40), policyVersion: 'project-review-policy.v1', policySha256 });
  assert.match(markdown, /infrastructure_failure/);
  assert.match(markdown, new RegExp(policySha256));
  assert.match(markdown, /No approval or code finding was inferred/);
  assert.match(markdown, /five votes unavailable/);
});
