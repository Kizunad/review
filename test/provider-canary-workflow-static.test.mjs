import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workflowPath = new URL('../.github/workflows/provider-canary.yml', import.meta.url);

async function workflow() {
  return readFile(workflowPath, 'utf8');
}

test('provider canary is a credential-isolated reusable workflow with immutable identity', async () => {
  const yaml = await workflow();
  assert.match(yaml, /^  workflow_call:$/m);
  assert.doesNotMatch(yaml, /^  (?:pull_request|push|issue_comment|workflow_dispatch):/m);
  assert.match(yaml, /^permissions: \{\}$/m);
  assert.match(yaml, /permissions:\n      actions: read/);
  assert.doesNotMatch(yaml, /contents:|pull-requests:|issues:/);
  assert.match(yaml, /Kizunad\/review\/\.github\/workflows\/provider-canary\.yml@/);
  assert.match(yaml, /expected exactly one central provider canary workflow reference/);
  assert.match(yaml, /actions\/runs\/\$GITHUB_RUN_ID\/attempts\/\$GITHUB_RUN_ATTEMPT/);
  assert.match(yaml, /ANTHROPIC_API_KEY: \$\{\{ secrets\.review_api_key \}\}/);
  assert.match(yaml, /ANTHROPIC_BASE_URL: \$\{\{ inputs\.review_base_url \}\}/);
  assert.doesNotMatch(yaml, /secrets:\s*inherit|checkout@|repository: \$\{\{ github\.repository \}\}/);
});

test('provider canary uses the production sandbox and uploads only bounded redacted diagnostics', async () => {
  const yaml = await workflow();
  assert.match(yaml, /uses: \.\/_central\/\.github\/actions\/setup-claude/);
  assert.match(yaml, /bubblewrap_0\.9\.0-1ubuntu0\.1_amd64\.deb/);
  assert.match(yaml, /node _central\/src\/run-provider-canary\.mjs/);
  assert.match(yaml, /PROVIDER_CANARY_TIMEOUT_MS: \$\{\{ inputs\.worker_timeout_ms \}\}/);
  assert.match(yaml, /_output\/provider-canary\.json/);
  assert.match(yaml, /retention-days: 1/);
  assert.match(yaml, /Preserve provider canary failure/);
  assert.doesNotMatch(yaml, /run-review|policy|pulls\/|issues\/|comments/);
  const uses = [...yaml.matchAll(/^\s*uses:\s*[^@\s]+@([^\s#]+)\s*$/gm)];
  assert.ok(uses.length > 0);
  for (const [, ref] of uses) assert.match(ref, /^[0-9a-f]{40}$/i);
});
