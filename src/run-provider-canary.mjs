#!/usr/bin/env node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runFreshClaude } from './claude-cli.mjs';

const models = ['sol', 'luna', 'terra'];

export async function runProviderCanary({
  environment = process.env,
  runClaude = runFreshClaude,
} = {}) {
  const required = [
    'CLAUDE_EXECUTABLE',
    'RIPGREP_EXECUTABLE',
    'BWRAP_EXECUTABLE',
    'PROVIDER_CANARY_OUTPUT',
  ];
  for (const key of required) {
    if (typeof environment[key] !== 'string' || environment[key].length === 0) {
      throw new Error(`${key} is required`);
    }
  }

  const timeoutMs = Number(environment.PROVIDER_CANARY_TIMEOUT_MS ?? '60000');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) {
    throw new Error('PROVIDER_CANARY_TIMEOUT_MS must be an integer from 1 through 300000');
  }

  const schema = {
    type: 'object',
    properties: {
      ok: { const: true },
    },
    required: ['ok'],
    additionalProperties: false,
  };
  const repository = await mkdtemp(path.join(tmpdir(), 'central-review-provider-canary-'));
  const outputPath = path.resolve(environment.PROVIDER_CANARY_OUTPUT);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(path.join(repository, 'README.txt'), 'Provider canary workspace. Do not use tools.\n');

  try {
    const probes = [];
    for (const model of models) {
      const result = await runClaude({
        model,
        prompt: 'Provider compatibility canary. Do not call any tool. Return exactly the structured value {"ok":true}.',
        jsonSchema: schema,
        executable: path.resolve(environment.CLAUDE_EXECUTABLE),
        ripgrepExecutable: path.resolve(environment.RIPGREP_EXECUTABLE),
        sandboxExecutable: path.resolve(environment.BWRAP_EXECUTABLE),
        cwd: repository,
        environment,
        timeoutMs,
        validate: (value) => value?.ok === true,
      });
      probes.push({
        model,
        status: result.status,
        ...(result.status === 'ok'
          ? { ok: result.data.ok }
          : { error: result.error, diagnostic: result.diagnostic ?? '' }),
      });
    }
    const report = {
      version: 'v1',
      success: probes.every((probe) => probe.status === 'ok'),
      probes,
    };
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    JSON.parse(await readFile(outputPath, 'utf8'));
    return report;
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await runProviderCanary();
  if (!report.success) process.exitCode = 2;
}
