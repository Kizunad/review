import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workflowPath = new URL('../.github/workflows/self-test.yml', import.meta.url);

test('central self-test runs on pull requests with read-only permissions and pinned actions', async () => {
  const yaml = await readFile(workflowPath, 'utf8');
  assert.match(yaml, /pull_request:/);
  assert.match(yaml, /permissions:\n  contents: read/);
  assert.match(yaml, /node --check src\/\*\.mjs/);
  assert.match(yaml, /npm test/);
  assert.match(yaml, /git diff --check/);
  assert.doesNotMatch(yaml, /ANTHROPIC_API_KEY|pull-requests: write|issues: write|secrets:/);
  const uses = [...yaml.matchAll(/^\s*uses:\s*[^@\s]+@([^\s#]+)\s*$/gm)];
  assert.ok(uses.length > 0);
  for (const [, ref] of uses) assert.match(ref, /^[0-9a-f]{40}$/i);
});
