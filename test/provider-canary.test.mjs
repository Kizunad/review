import { spawn } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runFreshClaude } from '../src/claude-cli.mjs';
import { runProviderCanary } from '../src/run-provider-canary.mjs';

async function fakeClaude(root, failModel) {
  const executable = path.join(root, 'fake-claude.mjs');
  await writeFile(executable, `#!/usr/bin/env node
const model = process.argv[process.argv.indexOf('--model') + 1];
if (model === ${JSON.stringify(failModel)}) {
  process.stdout.write(JSON.stringify({
    type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10,
    error_status: 524, error: 'gateway timeout',
  }) + '\\n');
  process.exit(2);
}
process.stdout.write(JSON.stringify({
  type: 'result', subtype: 'success', structured_output: { ok: true },
}) + '\\n');
`);
  await chmod(executable, 0o755);
  return executable;
}

async function execute(failModel = null) {
  const root = await mkdtemp(path.join(tmpdir(), 'provider-canary-test-'));
  const outputPath = path.join(root, 'provider-canary.json');
  const executable = await fakeClaude(root, failModel);
  const report = await runProviderCanary({
    environment: {
      PATH: process.env.PATH,
      CLAUDE_EXECUTABLE: executable,
      RIPGREP_EXECUTABLE: executable,
      BWRAP_EXECUTABLE: executable,
      PROVIDER_CANARY_OUTPUT: outputPath,
      PROVIDER_CANARY_TIMEOUT_MS: '1000',
      ANTHROPIC_API_KEY: 'provider-canary-test-secret',
      ANTHROPIC_BASE_URL: 'https://provider-canary-test.example',
    },
    runClaude: (options) => runFreshClaude({
      ...options,
      spawn: (_sandbox, args, spawnOptions) => {
        const separator = args.indexOf('--');
        return spawn(executable, args.slice(separator + 2), spawnOptions);
      },
    }),
  });
  return {
    report,
    persisted: JSON.parse(await readFile(outputPath, 'utf8')),
  };
}

test('probes sol, luna, and terra with one minimal structured request each', async () => {
  const { report, persisted } = await execute();
  assert.deepEqual(report, {
    version: 'v1',
    success: true,
    probes: [
      { model: 'sol', status: 'ok', ok: true },
      { model: 'luna', status: 'ok', ok: true },
      { model: 'terra', status: 'ok', ok: true },
    ],
  });
  assert.deepEqual(persisted, report);
});

test('records a redacted model-specific provider failure and still probes every alias', async () => {
  const { report } = await execute('luna');
  assert.equal(report.success, false);
  assert.deepEqual(report.probes.map(({ model, status }) => ({ model, status })), [
    { model: 'sol', status: 'ok' },
    { model: 'luna', status: 'infra_error' },
    { model: 'terra', status: 'ok' },
  ]);
  assert.match(report.probes[1].diagnostic, /api_retry/);
  assert.match(report.probes[1].diagnostic, /524/);
  assert.equal(JSON.stringify(report).includes('provider-canary-test-secret'), false);
  assert.equal(JSON.stringify(report).includes('provider-canary-test.example'), false);
});
