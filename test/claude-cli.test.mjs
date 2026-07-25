import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildClaudeArgs,
  buildSandboxArgs,
  runFreshClaude,
  sanitizedEnv,
} from '../src/claude-cli.mjs';

const schema = { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'], additionalProperties: false };
const executable = '/trusted/claude';
const ripgrepExecutable = '/trusted/rg';
const repositoryRoot = '/trusted/repository';

function resultEvent(structuredOutput = { verdict: 'PASS' }, overrides = {}) {
  return `${JSON.stringify({ type: 'result', subtype: 'success', structured_output: structuredOutput, ...overrides })}\n`;
}

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
    capture?.({ executable: _executable, args, options, child });
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

function baseRun(overrides = {}) {
  return {
    model: 'luna',
    prompt: 'x',
    jsonSchema: schema,
    executable,
    ripgrepExecutable,
    cwd: repositoryRoot,
    validate: () => true,
    ...overrides,
  };
}

function nativeTestExecutables() {
  const claude = process.env.CLAUDE_EXECUTABLE;
  const ripgrep = process.env.RIPGREP_EXECUTABLE;
  const bubblewrap = process.env.BWRAP_EXECUTABLE ?? 'bwrap';
  return claude && ripgrep ? { claude, ripgrep, bubblewrap } : null;
}

function writeSseEvent(response, event, data) {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function writeToolUses(response, uses) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  writeSseEvent(response, 'message_start', {
    type: 'message_start',
    message: {
      id: `message-${uses.map(({ id }) => id).join('-')}`,
      type: 'message',
      role: 'assistant',
      model: 'luna',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  });
  for (const [index, { id, name, input }] of uses.entries()) {
    writeSseEvent(response, 'content_block_start', {
      type: 'content_block_start', index,
      content_block: { type: 'tool_use', id, name, input: {} },
    });
    writeSseEvent(response, 'content_block_delta', {
      type: 'content_block_delta', index,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
    });
    writeSseEvent(response, 'content_block_stop', { type: 'content_block_stop', index });
  }
  writeSseEvent(response, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'tool_use', stop_sequence: null },
    usage: { output_tokens: uses.length },
  });
  writeSseEvent(response, 'message_stop', { type: 'message_stop' });
  response.end();
}

function writeToolUse(response, toolUse) {
  writeToolUses(response, [toolUse]);
}

async function withMockClaudeProvider(handler, run) {
  const server = createServer((request, response) => {
    if (request.method === 'HEAD') {
      response.writeHead(200);
      response.end();
      return;
    }
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => handler(JSON.parse(body), response));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function runNativeClaude({ claude, ripgrep, bubblewrap, repository, baseUrl, secret, prompt }) {
  return runFreshClaude({
    model: 'luna',
    prompt,
    jsonSchema: {
      type: 'object',
      properties: { done: { type: 'boolean' } },
      required: ['done'],
      additionalProperties: false,
    },
    executable: claude,
    ripgrepExecutable: ripgrep,
    sandboxExecutable: bubblewrap,
    cwd: repository,
    environment: {
      ANTHROPIC_API_KEY: secret,
      ANTHROPIC_BASE_URL: baseUrl,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
    timeoutMs: 30_000,
    validate: (value) => value?.done === true,
  });
}

function toolResultsFrom(message) {
  if (message?.role !== 'user' || !Array.isArray(message.content)) return [];
  return message.content.filter((block) => block?.type === 'tool_result');
}

function toolResultFrom(message) {
  return toolResultsFrom(message)[0] ?? null;
}

test('builds the fixed fresh read-only Claude command with inline schema JSON', () => {
  const args = buildClaudeArgs({ model: 'terra', prompt: 'review', jsonSchema: schema });
  assert.deepEqual(args, [
    '--safe-mode', '--disable-slash-commands', '--no-chrome',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '-p', 'review', '--no-session-persistence', '--model', 'terra', '--effort', 'max',
    '--tools', 'Read,Glob,Grep', '--allowedTools', 'Read(//workspace/**),Glob(//workspace/**),Grep(//workspace/**)', '--permission-mode', 'dontAsk',
    '--output-format', 'stream-json', '--verbose', '--json-schema', JSON.stringify(schema),
  ]);
  assert.equal(args.some((arg) => /resume|Bash|Edit|Write|--bare/.test(arg)), false);
  assert.ok(args.includes('--safe-mode'));
  assert.ok(args.includes('--disable-slash-commands'));
  assert.ok(args.includes('--strict-mcp-config'));
  assert.deepEqual(JSON.parse(args.at(-1)), schema);
  assert.throws(() => buildClaudeArgs({ model: 'opus', prompt: 'x', jsonSchema: schema }), /model/);
});

test('strips schema metadata unsupported by the Claude CLI validator', () => {
  const source = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'review-plan.schema.json',
    ...schema,
  };
  const args = buildClaudeArgs({ model: 'sol', prompt: 'plan', jsonSchema: source });
  const cliSchema = JSON.parse(args[args.indexOf('--json-schema') + 1]);

  assert.deepEqual(cliSchema, schema);
  assert.equal('$schema' in cliSchema, false);
  assert.equal('$id' in cliSchema, false);
});

test('builds a mount namespace exposing only the read-only repository and fixed Claude executable', () => {
  const claudeArgs = buildClaudeArgs({ model: 'terra', prompt: 'review', jsonSchema: schema });
  const args = buildSandboxArgs({
    executable,
    ripgrepExecutable,
    repositoryRoot,
    environment: {
      PATH: '/host/bin',
      HOME: '/host/home',
      NODE_EXTRA_CA_CERTS: '/host/caller-controlled.pem',
      ANTHROPIC_API_KEY: 'provider',
      ANTHROPIC_BASE_URL: 'https://gateway.example',
      GITHUB_TOKEN: 'github',
    },
    claudeArgs,
  });
  assert.deepEqual(args.slice(0, 10), [
    '--unshare-all', '--share-net', '--die-with-parent', '--new-session', '--as-pid-1',
    '--hostname', 'central-review', '--ro-bind', '/usr', '/usr',
  ]);
  assert.ok(args.includes('--clearenv'));
  assert.ok(args.includes('--proc'));
  assert.ok(args.includes('/proc/self/environ'));
  assert.ok(args.includes('/proc/1/environ'));
  assert.ok(args.includes('/proc/1/task'));
  assert.deepEqual(args.slice(args.indexOf('--ro-bind', args.indexOf('/sandbox')) + 1, args.indexOf('--ro-bind', args.indexOf('/sandbox')) + 3), [
    executable,
    '/sandbox/claude',
  ]);
  const repositoryBind = args.findIndex((value, index) => value === '--ro-bind' && args[index + 1] === repositoryRoot);
  assert.deepEqual(args.slice(repositoryBind, repositoryBind + 3), ['--ro-bind', repositoryRoot, '/workspace']);
  const ripgrepBind = args.findIndex((value, index) => value === '--ro-bind' && args[index + 1] === ripgrepExecutable);
  assert.deepEqual(args.slice(ripgrepBind, ripgrepBind + 3), ['--ro-bind', ripgrepExecutable, '/sandbox/rg']);
  assert.ok(args.includes('USE_BUILTIN_RIPGREP'));
  assert.equal(args[args.indexOf('USE_BUILTIN_RIPGREP') + 1], '0');
  assert.equal(args.includes('/host/home'), false);
  assert.equal(args.includes('/host/bin'), false);
  assert.equal(args.includes('/host/caller-controlled.pem'), false);
  assert.equal(args.includes('GITHUB_TOKEN'), false);
  assert.equal(args.includes('github'), false);
  assert.equal(args.at(args.indexOf('--') + 1), '/sandbox/claude');
  assert.deepEqual(args.slice(-claudeArgs.length), claudeArgs);
});

test('path-scopes every repository tool to the sanitized workspace', () => {
  const args = buildClaudeArgs({ model: 'terra', prompt: 'review', jsonSchema: schema });
  const allowed = args[args.indexOf('--allowedTools') + 1];
  assert.equal(allowed, 'Read(//workspace/**),Glob(//workspace/**),Grep(//workspace/**)');
  assert.equal(/(?:^|,)Glob(?:,|$)|(?:^|,)Grep(?:,|$)/.test(allowed), false);
  for (const tool of ['Read', 'Glob', 'Grep']) assert.match(allowed, new RegExp(`${tool}\\(//workspace/\\*\\*\\)`));
});


test('native Claude registers only Read, Glob, Grep, and StructuredOutput in safe mode', async (context) => {
  if (process.platform !== 'linux') return context.skip('Linux Bubblewrap test');
  const tools = nativeTestExecutables();
  if (!tools) return context.skip('CLAUDE_EXECUTABLE and RIPGREP_EXECUTABLE are required');
  const root = await mkdtemp(path.join(tmpdir(), 'claude-native-tools-'));
  const repository = path.join(root, 'repository');
  await mkdir(repository);
  await writeFile(path.join(repository, 'visible.txt'), 'needle\n');
  let advertisedTools;
  const result = await withMockClaudeProvider((request, response) => {
    advertisedTools ??= request.tools?.map((tool) => tool.name).sort();
    writeToolUse(response, { id: 'done', name: 'StructuredOutput', input: { done: true } });
  }, (baseUrl) => runNativeClaude({
    ...tools, repository, baseUrl, secret: 'native-tool-contract-secret', prompt: 'Return done=true.',
  }));
  assert.equal(result.status, 'ok');
  assert.deepEqual(advertisedTools, ['Glob', 'Grep', 'Read', 'StructuredOutput']);
});

test('native Grep rejects the exact provider credential oracle outside /workspace', async (context) => {
  if (process.platform !== 'linux') return context.skip('Linux Bubblewrap test');
  const tools = nativeTestExecutables();
  if (!tools) return context.skip('CLAUDE_EXECUTABLE and RIPGREP_EXECUTABLE are required');
  const root = await mkdtemp(path.join(tmpdir(), 'claude-native-credential-'));
  const repository = path.join(root, 'repository');
  await mkdir(repository);
  const secret = 'credential-oracle-must-not-match';
  let step = 0;
  let denied;
  const result = await withMockClaudeProvider((request, response) => {
    const toolResult = toolResultFrom(request.messages?.at(-1));
    if (toolResult?.tool_use_id === 'credential-oracle') denied = toolResult;
    if (step++ === 0) {
      writeToolUse(response, {
        id: 'credential-oracle',
        name: 'Grep',
        input: {
          pattern: `ANTHROPIC_API_KEY=${secret}`,
          path: '/proc/self/environ',
          output_mode: 'count',
          multiline: true,
        },
      });
      return;
    }
    writeToolUse(response, { id: 'done', name: 'StructuredOutput', input: { done: true } });
  }, (baseUrl) => runNativeClaude({
    ...tools, repository, baseUrl, secret, prompt: 'Use the requested tools, then return done=true.',
  }));
  assert.equal(result.status, 'ok');
  assert.equal(denied?.is_error, true);
  assert.match(String(denied?.content), /Permission to use Grep has been denied/);
  assert.doesNotMatch(String(denied?.content), /Found 1 total occurrence|\/proc\/self\/environ:1/);
});

test('native Grep remains functional for the sanitized /workspace snapshot', async (context) => {
  if (process.platform !== 'linux') return context.skip('Linux Bubblewrap test');
  const tools = nativeTestExecutables();
  if (!tools) return context.skip('CLAUDE_EXECUTABLE and RIPGREP_EXECUTABLE are required');
  const root = await mkdtemp(path.join(tmpdir(), 'claude-native-workspace-'));
  const repository = path.join(root, 'repository');
  await mkdir(repository);
  await writeFile(path.join(repository, 'visible.txt'), 'workspace-needle\n');
  let step = 0;
  let grepResult;
  const result = await withMockClaudeProvider((request, response) => {
    const toolResult = toolResultFrom(request.messages?.at(-1));
    if (toolResult?.tool_use_id === 'workspace-grep') grepResult = toolResult;
    if (step++ === 0) {
      writeToolUse(response, {
        id: 'workspace-grep',
        name: 'Grep',
        input: { pattern: 'workspace-needle', path: '/workspace', output_mode: 'content' },
      });
      return;
    }
    writeToolUse(response, { id: 'done', name: 'StructuredOutput', input: { done: true } });
  }, (baseUrl) => runNativeClaude({
    ...tools, repository, baseUrl, secret: 'workspace-grep-secret', prompt: 'Use the requested tools, then return done=true.',
  }));
  assert.equal(result.status, 'ok');
  assert.equal(grepResult?.is_error, undefined);
  assert.match(String(grepResult?.content), /visible\.txt.*workspace-needle/);
});


test('native repository tools reject proc aliases and concurrent credential scans', async (context) => {
  if (process.platform !== 'linux') return context.skip('Linux Bubblewrap test');
  const tools = nativeTestExecutables();
  if (!tools) return context.skip('CLAUDE_EXECUTABLE and RIPGREP_EXECUTABLE are required');
  const root = await mkdtemp(path.join(tmpdir(), 'claude-native-proc-boundary-'));
  const repository = path.join(root, 'repository');
  await mkdir(repository);
  const secret = 'proc-boundary-must-not-match';
  const attacks = [
    { id: 'read-self', name: 'Read', input: { file_path: '/proc/self/environ' } },
    { id: 'read-init', name: 'Read', input: { file_path: '/proc/1/environ' } },
    { id: 'read-self-root', name: 'Read', input: { file_path: '/proc/self/root/proc/self/environ' } },
    { id: 'read-normalized', name: 'Read', input: { file_path: '/workspace/../proc/self/environ' } },
    { id: 'glob-proc', name: 'Glob', input: { pattern: '/proc/*/environ' } },
    {
      id: 'grep-self', name: 'Grep',
      input: { pattern: `ANTHROPIC_API_KEY=${secret}`, path: '/proc/self/environ', output_mode: 'count', multiline: true },
    },
    {
      id: 'grep-init', name: 'Grep',
      input: { pattern: `ANTHROPIC_API_KEY=${secret}`, path: '/proc/1/environ', output_mode: 'count', multiline: true },
    },
    {
      id: 'grep-normalized', name: 'Grep',
      input: { pattern: `ANTHROPIC_API_KEY=${secret}`, path: '/workspace/../proc/self/environ', output_mode: 'count', multiline: true },
    },
    {
      id: 'grep-double-root', name: 'Grep',
      input: { pattern: `ANTHROPIC_API_KEY=${secret}`, path: '//proc/self/environ', output_mode: 'count', multiline: true },
    },
    {
      id: 'grep-proc-scan', name: 'Grep',
      input: { pattern: `ANTHROPIC_API_KEY=${secret}`, path: '/proc', glob: '*/environ', output_mode: 'count', multiline: true },
    },
  ];
  let step = 0;
  const results = new Map();
  const result = await withMockClaudeProvider((request, response) => {
    for (const toolResult of toolResultsFrom(request.messages?.at(-1))) {
      results.set(toolResult.tool_use_id, toolResult);
    }
    if (step++ === 0) {
      writeToolUses(response, attacks);
      return;
    }
    writeToolUse(response, { id: 'done', name: 'StructuredOutput', input: { done: true } });
  }, (baseUrl) => runNativeClaude({
    ...tools, repository, baseUrl, secret, prompt: 'Use every requested tool, then return done=true.',
  }));
  assert.equal(result.status, 'ok');
  assert.equal(results.size, attacks.length);
  for (const attack of attacks) {
    const toolResult = results.get(attack.id);
    assert.equal(toolResult?.is_error, true, `${attack.id} must fail without returning proc contents`);
    assert.match(
      String(toolResult?.content),
      /Permission to use (?:Read|Glob|Grep) has been denied|Cannot read '[^']*\/proc\/[^']+': this device file would block/,
    );
    assert.equal(String(toolResult?.content).includes(secret), false);
    assert.doesNotMatch(String(toolResult?.content), /Found 1 total occurrence|\/proc\/(?:self|1)\/environ:1/);
  }
});

test('loads schema files before spawning and validates structured_output, not the envelope', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'claude-schema-'));
  const schemaPath = path.join(directory, 'schema.json');
  await writeFile(schemaPath, JSON.stringify(schema));
  let captured;
  const result = await runFreshClaude({
    ...baseRun(),
    model: 'sol',
    jsonSchema: undefined,
    jsonSchemaPath: schemaPath,
    spawn: fakeSpawn({
      stdout: resultEvent({ verdict: 'PASS' }, { result: '{"ignored":true}' }),
      capture: (value) => { captured = value; },
    }),
    validate: (data) => data.verdict === 'PASS',
  });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.data, { verdict: 'PASS' });
  assert.equal(captured.executable, process.env.BWRAP_EXECUTABLE ?? 'bwrap');
  assert.equal(captured.options.cwd, undefined);
  assert.equal(captured.options.detached, process.platform !== 'win32');
  const separator = captured.args.indexOf('--');
  assert.equal(captured.args[separator + 1], '/sandbox/claude');
  assert.deepEqual(JSON.parse(captured.args.at(-1)), schema);
});

test('passes only the minimal controlled child environment', () => {
  const safe = sanitizedEnv({
    PATH: '/bin', HOME: '/tmp/home', LANG: 'C.UTF-8', ANTHROPIC_API_KEY: 'provider', ANTHROPIC_BASE_URL: 'https://gateway.example',
    GH_TOKEN: 'github', GITHUB_TOKEN: 'github', AWS_SESSION_TOKEN: 'aws', NPM_TOKEN: 'npm', RANDOM_SECRET: 'secret', KEEP: 'no',
  });
  assert.deepEqual(safe, {
    LANG: 'C.UTF-8', ANTHROPIC_API_KEY: 'provider', ANTHROPIC_BASE_URL: 'https://gateway.example',
  });
});

test('accepts only successful result envelopes and rejects error or unknown envelopes', async () => {
  assert.equal((await runFreshClaude(baseRun({ spawn: fakeSpawn({ stdout: resultEvent(undefined, { result: '{"verdict":"PASS"}', structured_output: undefined }) }) }))).status, 'ok');
  for (const envelope of [
    { type: 'error', structured_output: { verdict: 'PASS' } },
    { type: 'result', is_error: true, structured_output: { verdict: 'PASS' } },
    { type: 'result', subtype: 'error_max_turns', result: { verdict: 'PASS' } },
    { structured_output: { verdict: 'PASS' } },
  ]) {
    const result = await runFreshClaude(baseRun({ spawn: fakeSpawn({ stdout: `${JSON.stringify(envelope)}\n` }) }));
    assert.equal(result.status, 'infra_error');
  }
});

test('returns structured infra and schema errors rather than findings', async () => {
  assert.equal((await runFreshClaude(baseRun({ timeoutMs: 10, killGraceMs: 1, spawn: fakeSpawn({ error: new Error('missing') }) }))).status, 'infra_error');
  assert.equal((await runFreshClaude(baseRun({ timeoutMs: 10, killGraceMs: 1, spawn: fakeSpawn({ code: 2, stdout: '' }) }))).status, 'infra_error');
  assert.equal((await runFreshClaude(baseRun({ timeoutMs: 10, killGraceMs: 1, spawn: fakeSpawn({ stdout: 'nope' }) }))).status, 'infra_error');
  assert.equal((await runFreshClaude(baseRun({ timeoutMs: 10, killGraceMs: 1, spawn: fakeSpawn({ stdout: '{}' }), validate: () => false }))).status, 'infra_error');
  assert.equal((await runFreshClaude(baseRun({ timeoutMs: 10, killGraceMs: 1, spawn: fakeSpawn({ stdout: resultEvent({ verdict: 'FAIL' }) }), validate: () => false }))).status, 'schema_error');
  assert.equal((await runFreshClaude(baseRun({ timeoutMs: 10, killGraceMs: 1, spawn: fakeSpawn({ neverClose: true }) }))).status, 'infra_error');
  assert.equal((await runFreshClaude({ ...baseRun(), executable: 'claude', spawn: fakeSpawn() })).status, 'infra_error');
  assert.equal((await runFreshClaude({ ...baseRun(), cwd: 'relative', spawn: fakeSpawn() })).status, 'infra_error');
});

test('caps stdout and stderr by bytes and terminates overflowing children', async () => {
  for (const stream of ['stdout', 'stderr']) {
    let child;
    const result = await runFreshClaude(baseRun({
      model: 'terra', maxStdoutBytes: 4, maxStderrBytes: 4, killGraceMs: 1,
      spawn: fakeSpawn({
        neverClose: true,
        capture: ({ child: value }) => {
          child = value;
          queueMicrotask(() => value[stream].emit('data', Buffer.from('界界')));
        },
      }),
    }));
    assert.equal(result.status, 'infra_error');
    assert.match(result.error, new RegExp(`${stream} limit exceeded`));
    assert.deepEqual(child.signals, ['SIGTERM']);
  }
});

test('can include bounded lifecycle diagnostics on successful canary probes', async () => {
  const result = await runFreshClaude(baseRun({
    includeSuccessDiagnostic: true,
    spawn: fakeSpawn({
      stdout: [
        JSON.stringify({
          type: 'system',
          subtype: 'api_retry',
          attempt: 1,
          max_retries: 10,
          error_status: 503,
          error: 'temporarily unavailable',
        }),
        resultEvent({ verdict: 'PASS' }).trimEnd(),
        '',
      ].join('\n'),
    }),
  }));

  assert.equal(result.status, 'ok');
  assert.match(result.diagnostic, /api_retry/);
  assert.match(result.diagnostic, /"errorStatus":503/);
  assert.match(result.diagnostic, /"type":"result"/);
});

test('timeout returns bounded redacted stream lifecycle diagnostics', async () => {
  const secret = 'timeout-secret-value';
  const baseUrl = 'https://private-timeout-gateway.example';
  let child;
  const result = await runFreshClaude(baseRun({
    model: 'sol',
    environment: {
      ANTHROPIC_API_KEY: secret,
      ANTHROPIC_BASE_URL: baseUrl,
    },
    timeoutMs: 2,
    killGraceMs: 1,
    spawn: fakeSpawn({
      neverClose: true,
      capture: ({ child: value }) => {
        child = value;
        queueMicrotask(() => {
          value.stdout.emit('data', `${JSON.stringify({
            type: 'system',
            subtype: 'init',
            model: 'sol',
            apiKeySource: 'ANTHROPIC_API_KEY',
            claude_code_version: '2.1.220',
            secret,
          })}\n`);
          value.stdout.emit('data', `${JSON.stringify({
            type: 'system',
            subtype: 'api_retry',
            attempt: 2,
            max_retries: 10,
            error_status: 524,
            error: `gateway ${baseUrl}`,
          })}\n`);
          value.stderr.emit('data', `stderr ${secret} ${baseUrl}`);
        });
      },
    }),
  }));
  assert.equal(result.status, 'infra_error');
  assert.match(result.error, /timeout/);
  assert.match(result.diagnostic, /api_retry/);
  assert.match(result.diagnostic, /"attempt":2/);
  assert.match(result.diagnostic, /"errorStatus":524/);
  assert.match(result.diagnostic, /REDACTED/);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(JSON.stringify(result).includes(baseUrl), false);
  assert.deepEqual(child.signals, ['SIGTERM']);
});

test('timeout escalates from TERM to KILL when the child ignores TERM', async () => {
  let child;
  const result = await runFreshClaude(baseRun({
    model: 'terra', timeoutMs: 2, killGraceMs: 2,
    spawn: fakeSpawn({ neverClose: true, ignoreTerm: true, capture: ({ child: value }) => { child = value; } }),
  }));
  assert.equal(result.status, 'infra_error');
  assert.match(result.error, /timeout/);
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
});

test('redacts inherited credentials and provider endpoints from every returned diagnostic', async () => {
  const secret = 'super-secret-provider-value';
  const baseUrl = 'https://private-gateway.example/tenant';
  const environment = { PATH: '/bin', ANTHROPIC_API_KEY: secret, ANTHROPIC_BASE_URL: baseUrl, GITHUB_TOKEN: 'github-secret' };
  const nonzero = await runFreshClaude(baseRun({
    environment,
    spawn: fakeSpawn({ code: 2, stderr: `provider=${secret} base=${baseUrl} token=github-secret` }),
  }));
  assert.equal(JSON.stringify(nonzero).includes(secret), false);
  assert.equal(JSON.stringify(nonzero).includes(baseUrl), false);
  assert.equal(JSON.stringify(nonzero).includes('github-secret'), false);
  assert.match(nonzero.error, /claude exited 2: .*REDACTED/);
  assert.match(nonzero.diagnostic, /REDACTED/);

  const malformed = await runFreshClaude(baseRun({
    environment,
    spawn: fakeSpawn({ stdout: `not-json-${secret}-${baseUrl}` }),
  }));
  assert.equal(JSON.stringify(malformed).includes(secret), false);
  assert.equal(JSON.stringify(malformed).includes(baseUrl), false);
  assert.match(malformed.stdout, /REDACTED/);
});

test('real Bubblewrap namespace exposes only the separately pinned ripgrep executable', async (context) => {
  if (process.platform !== 'linux') return context.skip('Linux Bubblewrap test');
  const tools = nativeTestExecutables();
  if (!tools) return context.skip('CLAUDE_EXECUTABLE and RIPGREP_EXECUTABLE are required');
  const root = await mkdtemp(path.join(tmpdir(), 'claude-bwrap-rg-'));
  const repository = path.join(root, 'repository');
  const executable = path.join(root, 'fake-claude.mjs');
  await (await import('node:fs/promises')).mkdir(repository);
  await writeFile(path.join(repository, 'visible.txt'), 'needle\n');
  await writeFile(executable, `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
const version = spawnSync('/sandbox/rg', ['--version'], {
  encoding: 'utf8',
  env: { PATH: process.env.PATH },
});
const scoped = spawnSync('/sandbox/rg', ['needle', '/workspace/visible.txt'], {
  encoding: 'utf8',
  env: { PATH: process.env.PATH },
});
process.stdout.write(JSON.stringify({
  type: 'result',
  structured_output: {
    versionStatus: version.status,
    versionOutput: version.stdout,
    scopedStatus: scoped.status,
    scopedOutput: scoped.stdout,
  },
}) + '\\n');
`);
  await chmod(executable, 0o755);
  const result = await runFreshClaude({
    model: 'terra',
    prompt: 'probe',
    jsonSchema: { type: 'object' },
    executable,
    ripgrepExecutable: tools.ripgrep,
    sandboxExecutable: tools.bubblewrap,
    cwd: repository,
    environment: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'provider-secret' },
    validate: () => true,
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.data.versionStatus, 0);
  assert.match(result.data.versionOutput, /^ripgrep 14\.1\.1/m);
  assert.equal(result.data.scopedStatus, 0);
  assert.match(result.data.scopedOutput, /needle/);
});

test('real Bubblewrap namespace hides host files and keeps the repository read-only', async (context) => {
  if (process.platform !== 'linux') return context.skip('Linux Bubblewrap test');
  const tools = nativeTestExecutables();
  if (!tools) return context.skip('CLAUDE_EXECUTABLE and RIPGREP_EXECUTABLE are required');
  const root = await mkdtemp(path.join(tmpdir(), 'claude-bwrap-'));
  const repository = path.join(root, 'repository');
  const outside = path.join(root, 'outside.txt');
  const worker = path.join(root, 'worker.mjs');
  await (await import('node:fs/promises')).mkdir(repository);
  await writeFile(path.join(repository, 'visible.txt'), 'visible');
  await writeFile(outside, 'outside');
  await writeFile(worker, `#!/usr/bin/env node
import { access, readFile, readdir, writeFile } from 'node:fs/promises';
const results = {};
results.cwd = process.cwd();
results.visible = await readFile('/workspace/visible.txt', 'utf8');
try { await access(${JSON.stringify(outside)}); results.outside = true; } catch { results.outside = false; }
try { await writeFile('/workspace/mutation.txt', 'bad'); results.writable = true; } catch { results.writable = false; }
results.procEnvironmentReadable = [];
const procPaths = [
  '/proc/self/environ',
  '/proc/1/environ',
  '/proc/thread-self/environ',
  '/proc/self/task/1/environ',
  '/proc/1/task/1/environ',
];
for (const pid of (await readdir('/proc')).filter((entry) => /^\\d+$/.test(entry))) {
  procPaths.push('/proc/' + pid + '/environ');
  try {
    for (const tid of await readdir('/proc/' + pid + '/task')) {
      procPaths.push('/proc/' + pid + '/task/' + tid + '/environ');
    }
  } catch {}
}
for (const procPath of new Set(procPaths)) {
  try {
    const value = await readFile(procPath, 'utf8');
    if (value.includes('not-visible-through-proc')) results.procEnvironmentReadable.push(procPath);
  } catch {}
}
process.stdout.write(JSON.stringify({ type: 'result', structured_output: results }) + '\\n');
`);
  await chmod(worker, 0o755);
  const result = await runFreshClaude({
    model: 'terra',
    prompt: 'probe',
    jsonSchema: { type: 'object' },
    executable: worker,
    ripgrepExecutable: tools.ripgrep,
    sandboxExecutable: tools.bubblewrap,
    cwd: repository,
    environment: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'not-visible-through-proc' },
    validate: () => true,
  });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.data, {
    cwd: '/workspace',
    visible: 'visible',
    outside: false,
    writable: false,
    procEnvironmentReadable: [],
  });
});
