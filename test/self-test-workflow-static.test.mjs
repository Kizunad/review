import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workflowPath = new URL('../.github/workflows/self-test.yml', import.meta.url);

async function workflow() {
  return readFile(workflowPath, 'utf8');
}

test('self-test installs Claude and the same pinned setuid Bubblewrap before exercising namespace tests', async () => {
  const yaml = await workflow();
  assert.match(yaml, /runs-on: ubuntu-24\.04/);
  assert.match(yaml, /uses: \.\/\.github\/actions\/setup-claude/);
  assert.match(yaml, /Smoke-test production Claude namespace/);
  assert.match(yaml, /buildSandboxArgs/);
  assert.match(yaml, /claudeArgs: \["--version"\]/);
  assert.match(yaml, /bubblewrap_0\.9\.0-1ubuntu0\.1_amd64\.deb/);
  assert.match(yaml, /1b506492bd9c7fd0cdb4f02ac822f1d3e336b0aead5113c1239baf8db5db562a/);
  assert.match(yaml, /sha256sum --check --strict/);
  assert.match(yaml, /sudo chown root:root "\$bwrap_executable"/);
  assert.match(yaml, /sudo chmod 4755 "\$bwrap_executable"/);
  assert.match(yaml, /root:root 4755/);
  assert.match(yaml, /CLAUDE_EXECUTABLE: \$\{\{ env\.CLAUDE_EXECUTABLE \}\}/);
  assert.match(yaml, /BWRAP_EXECUTABLE: \$\{\{ env\.BWRAP_EXECUTABLE \}\}/);
  assert.match(yaml, /RIPGREP_EXECUTABLE: \$\{\{ env\.RIPGREP_EXECUTABLE \}\}/);
  assert.match(yaml, /ripgrepExecutable: process\.env\.RIPGREP_EXECUTABLE/);
  assert.match(yaml, /npm test/);
});
