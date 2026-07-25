import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workflowPath = new URL('../.github/workflows/review.yml', import.meta.url);

async function workflow() {
  return readFile(workflowPath, 'utf8');
}

test('workflow derives central checkout identity from immutable workflow_ref', async () => {
  const yaml = await workflow();
  assert.match(yaml, /WORKFLOW_REF: \$\{\{ github\.workflow_ref \}\}/);
  assert.match(yaml, /\.github\/workflows\/review\\\.yml@\(\[0-9a-fA-F\]\{40\}\)/);
  assert.match(yaml, /repository="\$\{BASH_REMATCH\[1\]\}"/);
  assert.match(yaml, /ref="\$\{BASH_REMATCH\[2\],,\}"/);
  assert.doesNotMatch(yaml, /github\.action_(?:repository|ref)/);
});

test('workflow obtains base history and never runs caller scripts', async () => {
  const yaml = await workflow();
  const callerCheckout = /Checkout exact caller head into isolated directory[\s\S]*?fetch-depth: 0/.test(yaml);
  assert.equal(callerCheckout, true, 'caller checkout must fetch base history before diffing API base OID');
  assert.match(yaml, /git -C _caller[^\n]*diff[^\n]*"\$BASE_OID" "\$HEAD_OID"/);
  assert.doesNotMatch(yaml, /(?:npm|yarn|pnpm|bash|sh)\s+(?:_caller|\.\/_caller|_caller\/)/);
});

test('workflow wires pinned Claude Code to the deterministic read-only runner', async () => {
  const yaml = await workflow();
  assert.match(yaml, /@anthropic-ai\/claude-code@2\.1\.220/);
  assert.match(yaml, /sha512-ogBrvwkqF9f8okmnXKxmRNHuvtFxFEffe5pWdqOV3iQDxlUOKirFqnyWC7NGXXnDA4WkkbPH8pvSbwyCR2Auyw==/);
  assert.match(yaml, /node _central\/src\/run-review\.mjs/);
  assert.match(yaml, /ANTHROPIC_API_KEY: \$\{\{ secrets\.review_api_key \}\}/);
  assert.match(yaml, /ANTHROPIC_BASE_URL: \$\{\{ inputs\.review_base_url \}\}/);
  assert.match(yaml, /POLICY_FILE: \$\{\{ github\.workspace \}\}\/_trusted\/policy\.json/);
  assert.doesNotMatch(yaml, /secrets:\s*inherit/);
});

test('workflow separates read-only review from the only write-capable finalizer', async () => {
  const yaml = await workflow();
  const review = yaml.match(/\n  review:\n([\s\S]*?)\n  finalize:\n/)?.[1] ?? '';
  const finalize = yaml.match(/\n  finalize:\n([\s\S]*)$/)?.[1] ?? '';
  assert.match(review, /contents: read/);
  assert.match(review, /pull-requests: read/);
  assert.doesNotMatch(review, /pull-requests: write|issues: write/);
  assert.match(finalize, /pull-requests: write/);
  assert.match(finalize, /issues: write/);
  assert.doesNotMatch(finalize, /ANTHROPIC_API_KEY|review_api_key/);
});
test('every referenced action is pinned to a full commit SHA', async () => {
  const yaml = await workflow();
  const uses = [...yaml.matchAll(/^\s*uses:\s*[^@\s]+@([^\s#]+)\s*$/gm)];
  assert.ok(uses.length > 0, 'workflow must reference pinned actions');
  for (const [, ref] of uses) assert.match(ref, /^[0-9a-f]{40}$/i, `action ref is not immutable: ${ref}`);
});
