import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildClaudeArgs, runFreshClaude, sanitizedEnv } from '../src/claude-cli.mjs';

const schema = { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'], additionalProperties: false };

function fakeSpawn({ stdout = '{}', stderr = '', code = 0, error, neverClose = false, ignoreTerm = false, capture } = {}) {
  return (_executable, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = undefined;
    child.signals = [];
    child.kill = (signal = 'SIGTERM') => {
      child.signals.push(signal);
      if (signal === 'SIGKILL' || !ignoreTerm) queueMicrotask(() => child.emit('close', null, signal));
      return true;
    };
    capture?.({ args, options, child });
    queueMicrotask(() => {
      if (error) child.emit('error', error);
      else if (!neverClose) {
        if (stdout !== undefined) child.stdout.emit('data', stdout);
        if (stderr) child.stderr.emit('data', stderr);
        child.emit('close', code, null);
      }
    });
    return child;
  };
}

test('builds the fixed fresh read-only Claude command with inline schema JSON', () => {
  const args = buildClaudeArgs({ model: 'terra', prompt: 'review', jsonSchema: schema });
  assert.deepEqual(args, [
    '--bare', '--safe-mode', '--disable-slash-commands', '--no-chrome',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '-p', 'review', '--no-session-persistence', '--model', 'terra', '--effort', 'max',
    '--tools', 'Read,Glob,Grep', '--allowedTools', 'Read,Glob,Grep', '--permission-mode', 'dontAsk',
    '--output-format', 'json', '--json-schema', JSON.stringify(schema),
  ]);
  assert.equal(args.some((arg) => /resume|Bash|Edit|Write/.test(arg)), false);
  assert.ok(args.includes('--safe-mode'));
  assert.ok(args.includes('--disable-slash-commands'));
  assert.ok(args.includes('--strict-mcp-config'));
  assert.deepEqual(JSON.parse(args.at(-1)), schema);
  assert.throws(() => buildClaudeArgs({ model: 'opus', prompt: 'x', jsonSchema: schema }), /model/);
});

test('loads schema files before spawning and validates structured_output, not the envelope', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'claude-schema-'));
  const schemaPath = path.join(directory, 'schema.json');
  await writeFile(schemaPath, JSON.stringify(schema));
  let captured;
  const result = await runFreshClaude({
    model: 'sol', prompt: 'x', jsonSchemaPath: schemaPath,
    spawn: fakeSpawn({
      stdout: JSON.stringify({ type: 'result', result: '{"ignored":true}', structured_output: { verdict: 'PASS' } }),
      capture: (value) => { captured = value; },
    }),
    validate: (data) => data.verdict === 'PASS',
  });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.data, { verdict: 'PASS' });
  assert.deepEqual(JSON.parse(captured.args.at(-1)), schema);
  assert.equal(captured.options.detached, process.platform !== 'win32');
});

test('passes only the minimal controlled child environment', () => {
  const safe = sanitizedEnv({
    PATH: '/bin', HOME: '/tmp/home', LANG: 'C.UTF-8', ANTHROPIC_API_KEY: 'provider', ANTHROPIC_BASE_URL: 'https://gateway.example',
    GH_TOKEN: 'github', GITHUB_TOKEN: 'github', AWS_SESSION_TOKEN: 'aws', NPM_TOKEN: 'npm', RANDOM_SECRET: 'secret', KEEP: 'no',
  });
  assert.deepEqual(safe, {
    PATH: '/bin', HOME: '/tmp/home', LANG: 'C.UTF-8', ANTHROPIC_API_KEY: 'provider', ANTHROPIC_BASE_URL: 'https://gateway.example',
  });
});

test('accepts only successful result envelopes and rejects error or unknown envelopes', async () => {
  const base = { model: 'luna', prompt: 'x', jsonSchema: schema, validate: () => true };
  assert.equal((await runFreshClaude({ ...base, spawn: fakeSpawn({ stdout: JSON.stringify({ type: 'result', result: '{"verdict":"PASS"}' }) }) })).status, 'ok');
  for (const envelope of [
    { type: 'error', structured_output: { verdict: 'PASS' } },
    { type: 'result', is_error: true, structured_output: { verdict: 'PASS' } },
    { type: 'result', subtype: 'error_max_turns', result: { verdict: 'PASS' } },
    { structured_output: { verdict: 'PASS' } },
  ]) {
    const result = await runFreshClaude({ ...base, spawn: fakeSpawn({ stdout: JSON.stringify(envelope) }) });
    assert.equal(result.status, 'infra_error');
  }
});

test('returns structured infra and schema errors rather than findings', async () => {
  const base = { model: 'luna', prompt: 'x', jsonSchema: schema, timeoutMs: 10, killGraceMs: 1 };
  assert.equal((await runFreshClaude({ ...base, spawn: fakeSpawn({ error: new Error('missing') }) })).status, 'infra_error');
  assert.equal((await runFreshClaude({ ...base, spawn: fakeSpawn({ code: 2, stdout: '' }) })).status, 'infra_error');
  assert.equal((await runFreshClaude({ ...base, spawn: fakeSpawn({ stdout: 'nope' }) })).status, 'infra_error');
  assert.equal((await runFreshClaude({ ...base, spawn: fakeSpawn({ stdout: '{}' }), validate: () => false })).status, 'infra_error');
  assert.equal((await runFreshClaude({ ...base, spawn: fakeSpawn({ stdout: JSON.stringify({ type: 'result', structured_output: { verdict: 'FAIL' } }) }), validate: () => false })).status, 'schema_error');
  assert.equal((await runFreshClaude({ ...base, spawn: fakeSpawn({ neverClose: true }) })).status, 'infra_error');
});

test('caps stdout and stderr by bytes and terminates overflowing children', async () => {
  for (const stream of ['stdout', 'stderr']) {
    let child;
    const result = await runFreshClaude({
      model: 'terra', prompt: 'x', jsonSchema: schema, maxStdoutBytes: 4, maxStderrBytes: 4, killGraceMs: 1,
      spawn: fakeSpawn({
        neverClose: true,
        capture: ({ child: value }) => {
          child = value;
          queueMicrotask(() => value[stream].emit('data', Buffer.from('界界')));
        },
      }),
    });
    assert.equal(result.status, 'infra_error');
    assert.match(result.error, new RegExp(`${stream} limit exceeded`));
    assert.deepEqual(child.signals, ['SIGTERM']);
  }
});

test('timeout escalates from TERM to KILL when the child ignores TERM', async () => {
  let child;
  const result = await runFreshClaude({
    model: 'terra', prompt: 'x', jsonSchema: schema, timeoutMs: 2, killGraceMs: 2,
    spawn: fakeSpawn({ neverClose: true, ignoreTerm: true, capture: ({ child: value }) => { child = value; } }),
  });
  assert.equal(result.status, 'infra_error');
  assert.match(result.error, /timeout/);
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
});

test('redacts inherited secrets from every returned diagnostic', async () => {
  const secret = 'super-secret-provider-value';
  const environment = { PATH: '/bin', ANTHROPIC_API_KEY: secret, GITHUB_TOKEN: 'github-secret' };
  const nonzero = await runFreshClaude({
    model: 'terra', prompt: 'x', jsonSchema: schema, environment,
    spawn: fakeSpawn({ code: 2, stderr: `provider=${secret} token=github-secret` }),
  });
  assert.equal(JSON.stringify(nonzero).includes(secret), false);
  assert.equal(JSON.stringify(nonzero).includes('github-secret'), false);
  assert.match(nonzero.stderr, /REDACTED/);

  const malformed = await runFreshClaude({
    model: 'terra', prompt: 'x', jsonSchema: schema, environment,
    spawn: fakeSpawn({ stdout: `not-json-${secret}` }),
  });
  assert.equal(JSON.stringify(malformed).includes(secret), false);
  assert.match(malformed.stdout, /REDACTED/);
});
