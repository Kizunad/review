import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
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
  const executable = path.join(root, 'fake-claude.sh');
  await writeFile(executable, `#!/bin/sh
set -eu
[ "$PWD" = /workspace ]
[ "$HOME" = /home/claude ]
[ -f src/a.mjs ]
[ ! -e .claude ]
[ ! -e .mcp.json ]
[ ! -e CLAUDE.md ]
[ ! -e ${JSON.stringify(path.join(callerRoot, 'CLAUDE.md'))} ]
model=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = '--model' ]; then model="$2"; break; fi
  shift
done
case "$model" in
  sol) output='{"version":"v1","assignments":[{"id":"all","shardIndexes":[0]}]}' ;;
  luna) output='{"version":"v1","summary":"one changed file","files":["src/a.mjs"]}' ;;
  terra) output='[]' ;;
  *) exit 9 ;;
esac
printf '{"type":"result","structured_output":%s}\n' "$output"
`);
  await chmod(executable, 0o755);
  return { callerRoot, executable };
}

test('executes every review stage inside the isolated sanitized snapshot', async () => {
  const { callerRoot, executable } = await fixture();
  const result = await executeReview({
    centralRoot: path.resolve('.'),
    callerRoot,
    repository: 'org/repo',
    diff: 'diff --git a/src/a.mjs b/src/a.mjs\n+changed\n',
    policy,
    policySha256,
    executable,
    ripgrepExecutable: executable,
    environment: { PATH: process.env.PATH, REVIEW_HEAD_OID: 'a'.repeat(40) },
  });
  assert.equal(result.review.decision, 'approve');
  assert.deepEqual(result.review.findings, []);
  assert.deepEqual(result.review.failures, []);
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
    failures: [{
      stage: 'validate:x',
      status: 'infra_error',
      error: 'five votes unavailable',
      diagnostic: '{"events":[{"type":"system","subtype":"api_retry","errorStatus":524}]}',
    }],
  }, { headOid: 'b'.repeat(40), policyVersion: 'project-review-policy.v1', policySha256 });
  assert.match(markdown, /infrastructure_failure/);
  assert.match(markdown, new RegExp(policySha256));
  assert.match(markdown, /No approval or code finding was inferred/);
  assert.match(markdown, /five votes unavailable/);
  assert.match(markdown, /api_retry/);
  assert.match(markdown, /524/);
});
