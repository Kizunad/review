import { spawn } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PROVIDER_MODEL_IDS, runFreshClaude } from '../src/claude-cli.mjs';
import { runProviderCanary } from '../src/run-provider-canary.mjs';

async function fakeClaude(root, failModel) {
  const executable = path.join(root, 'fake-claude.mjs');
  await writeFile(executable, `#!/usr/bin/env node
const model = process.argv[process.argv.indexOf('--model') + 1];
if (model === ${JSON.stringify(failModel ? PROVIDER_MODEL_IDS[failModel] : null)}) {
  process.stdout.write(JSON.stringify({
    type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10,
    error_status: 524, error: 'gateway timeout',
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'result', subtype: 'success', is_error: true,
    api_error_status: 400, terminal_reason: 'api_error',
    result: 'API Error: 400 model not found: ' + model
      + '; key=provider-canary-test-secret'
      + '; endpoint=https://provider-canary-test.example'
      + '; Bearer leaked-bearer; token=leaked-token',
  }) + '\\n');
  process.exitCode = 1;
} else {
  process.stdout.write(JSON.stringify({
    type: 'result', subtype: 'success', structured_output: { ok: true },
  }) + '\\n');
}
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
      PROVIDER_CANARY_TIMEOUT_MS: '5000',
      ANTHROPIC_API_KEY: 'provider-canary-test-secret',
      ANTHROPIC_BASE_URL: 'https://provider-canary-test.example',
    },
    runClaude: (options) => runFreshClaude({
      ...options,
      spawn: (_sandbox, args, spawnOptions) => {
        const separator = args.indexOf('--');
        return spawn(process.execPath, [executable, ...args.slice(separator + 2)], spawnOptions);
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
  assert.equal(report.version, 'v1');
  assert.equal(report.success, true);
  assert.deepEqual(report.probes.map(({ model, status, ok }) => ({ model, status, ok })), [
    { model: 'sol', status: 'ok', ok: true },
    { model: 'luna', status: 'ok', ok: true },
    { model: 'terra', status: 'ok', ok: true },
  ]);
  assert.ok(report.probes.every((probe) => probe.diagnostic.includes('"type":"result"')));
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
  assert.match(report.probes[1].diagnostic, /"apiErrorStatus":400/);
  assert.match(report.probes[1].diagnostic, /"terminalReason":"api_error"/);
  assert.match(report.probes[1].diagnostic, /model not found: gpt-5\.6-luna/);
  assert.match(report.probes[1].diagnostic, /REDACTED/);
  assert.equal(JSON.stringify(report).includes('provider-canary-test-secret'), false);
  assert.equal(JSON.stringify(report).includes('provider-canary-test.example'), false);
  assert.equal(JSON.stringify(report).includes('leaked-bearer'), false);
  assert.equal(JSON.stringify(report).includes('leaked-token'), false);
});

function validEnvironment(overrides = {}) {
  return {
    CLAUDE_EXECUTABLE: '/trusted/claude',
    RIPGREP_EXECUTABLE: '/trusted/rg',
    BWRAP_EXECUTABLE: '/trusted/bwrap',
    PROVIDER_CANARY_OUTPUT: '/tmp/provider-canary.json',
    PROVIDER_CANARY_TIMEOUT_MS: '1000',
    ANTHROPIC_API_KEY: 'provider-canary-test-secret',
    ANTHROPIC_BASE_URL: 'https://provider-canary-test.example',
    ...overrides,
  };
}

test('rejects missing required canary environment before probing a model', async () => {
  for (const key of [
    'CLAUDE_EXECUTABLE',
    'RIPGREP_EXECUTABLE',
    'BWRAP_EXECUTABLE',
    'PROVIDER_CANARY_OUTPUT',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
  ]) {
    const environment = validEnvironment();
    delete environment[key];
    let calls = 0;
    await assert.rejects(
      () => runProviderCanary({
        environment,
        runClaude: async () => {
          calls += 1;
          return { status: 'ok', data: { ok: true } };
        },
      }),
      new RegExp(`${key} is required`),
    );
    assert.equal(calls, 0, `${key} must fail before any provider probe`);
  }
});

test('rejects canary timeouts outside the supported interval', async () => {
  for (const timeout of ['0', '300001', '1.5', 'not-a-number']) {
    let calls = 0;
    await assert.rejects(
      () => runProviderCanary({
        environment: validEnvironment({ PROVIDER_CANARY_TIMEOUT_MS: timeout }),
        runClaude: async () => {
          calls += 1;
          return { status: 'ok', data: { ok: true } };
        },
      }),
      /PROVIDER_CANARY_TIMEOUT_MS must be an integer from 1 through 300000/,
    );
    assert.equal(calls, 0, `${timeout} must fail before any provider probe`);
  }
});
