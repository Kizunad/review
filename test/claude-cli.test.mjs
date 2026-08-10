// The schema moved from argv into the prompt. These tests are about how the SCHEMA is
// transformed - array wrapping, unsupported metadata, RE2 patterns - not about where it travels,
// so they read it from its new home through one helper instead of each knowing the layout.
const schemaFromPrompt = (prompt) => JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n') + 2));

import { spawn as nodeSpawn } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildClaudeArgs,
  promptWithSchema,
  buildSandboxArgs,
  runFreshClaude,
  sanitizedEnv,
} from '../src/claude-cli.mjs';
import { createCredentialProxy } from '../src/credential-proxy.mjs';

const schema = { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'], additionalProperties: false };
const executable = '/trusted/claude';
const ripgrepExecutable = '/trusted/rg';
const repositoryRoot = '/trusted/repository';

function resultEvent(structuredOutput = { verdict: 'PASS' }, overrides = {}) {
  return `${JSON.stringify({ type: 'result', subtype: 'success', structured_output: structuredOutput, ...overrides })}\n`;
}

function fakeSpawn({ stdout = '{}', stderr = '', code = 0, error, stdinError, neverClose = false, ignoreTerm = false, capture } = {}) {
  return (_executable, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.writes = [];
    child.stdin.end = (chunk) => {
      if (chunk !== undefined) child.stdin.writes.push(Buffer.from(chunk));
      if (stdinError) queueMicrotask(() => child.stdin.emit('error', stdinError));
      else child.stdin.emit('finish');
    };
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

// The reply shape the new contract actually uses: ordinary assistant text carrying the JSON.
// There is no StructuredOutput tool to answer with any more, so a mock that still answers with
// one is answering with a tool the CLI never advertised - which is a 30s hang, not a failure.
// A reply that carries a THINKING block before its text, which is what an
// upstream in thinking mode actually returns. Needed to test the second 400
// family: Console Go's deserialiser only accepts 'text' content blocks, so any
// request body echoing a 'thinking' block back is rejected outright with
// `messages[N] unknown variant 'thinking'`. A mock that returns plain text can
// never exercise that - there would be nothing to echo, and the test would pass
// for free.
function writeThinkingThenText(response, thought, text) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  writeSseEvent(response, 'message_start', {
    type: 'message_start',
    message: {
      id: 'message-thinking', type: 'message', role: 'assistant', model: 'luna',
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  });
  writeSseEvent(response, 'content_block_start', {
    type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' },
  });
  writeSseEvent(response, 'content_block_delta', {
    type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: thought },
  });
  writeSseEvent(response, 'content_block_stop', { type: 'content_block_stop', index: 0 });
  writeSseEvent(response, 'content_block_start', {
    type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' },
  });
  writeSseEvent(response, 'content_block_delta', {
    type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text },
  });
  writeSseEvent(response, 'content_block_stop', { type: 'content_block_stop', index: 1 });
  writeSseEvent(response, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 2 },
  });
  writeSseEvent(response, 'message_stop', { type: 'message_stop' });
  response.end();
}

function writeText(response, text) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  writeSseEvent(response, 'message_start', {
    type: 'message_start',
    message: {
      id: 'message-text', type: 'message', role: 'assistant', model: 'luna',
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  });
  writeSseEvent(response, 'content_block_start', {
    type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' },
  });
  writeSseEvent(response, 'content_block_delta', {
    type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text },
  });
  writeSseEvent(response, 'content_block_stop', { type: 'content_block_stop', index: 0 });
  writeSseEvent(response, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 1 },
  });
  writeSseEvent(response, 'message_stop', { type: 'message_stop' });
  response.end();
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

test('builds the fixed fresh Claude command - neither prompt nor schema rides in argv', () => {
  const args = buildClaudeArgs({ model: 'terra', prompt: 'review', jsonSchema: schema });
  assert.deepEqual(args, [
    '--safe-mode', '--disable-slash-commands', '--no-chrome',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    // -p and the trailing --json-schema pair are both gone (the schema rides in the
    // prompt, #45). The tool whitelist is replaced here - that is this PR's argument:
    // the sandbox is the boundary, so the whitelist that had to enumerate capabilities
    // in advance is dropped for --dangerously-skip-permissions.
    '--no-session-persistence', '--model', 'terra', '--effort', 'max',
    '--dangerously-skip-permissions',
    '--output-format', 'stream-json', '--verbose',
  ]);
  assert.equal(args.includes('review'), false);
  assert.equal(args.some((arg) => /resume|Bash|Edit|Write|--bare/.test(arg)), false);
  assert.ok(args.includes('--safe-mode'));
  assert.ok(args.includes('--disable-slash-commands'));
  assert.ok(args.includes('--strict-mcp-config'));
  // --json-schema is gone, so nothing in argv may name a schema any more. Asserting the flag is
  // absent would pass even if the JSON were still being appended positionally; assert instead
  // that no argument parses as the schema, and that the flag itself is nowhere.
  assert.equal(args.includes('--json-schema'), false);
  assert.equal(args.some((arg) => arg.includes('"verdict"')), false);
  // Where it went instead. This is the only place the two halves are tied together.
  assert.deepEqual(schemaFromPrompt(promptWithSchema('review', schema)), schema);
  // Shape gate, not membership: the relay owns the valid set, so an arbitrary
  // well-formed name passes; malformed or flag-shaped names must throw.
  assert.ok(buildClaudeArgs({ model: 'cc-review', prompt: 'x', jsonSchema: schema }).includes('cc-review'));
  for (const bad of ['', ' sol', 'a b', '--model-injection', undefined]) {
    assert.throws(() => buildClaudeArgs({ model: bad, prompt: 'x', jsonSchema: schema }), /model/);
  }
});

test('streams a large prompt through stdin without placing it in argv', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-large-prompt-'));
  const worker = path.join(root, 'stdin-worker.mjs');
  const promptSentinel = 'prompt-sentinel-7f3a';
  await writeFile(worker, `#!/usr/bin/env node
import { createHash } from 'node:crypto';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks);
process.stdout.write(JSON.stringify({
  type: 'result',
  structured_output: {
    bytes: prompt.length,
    sha256: createHash('sha256').update(prompt).digest('hex'),
    argvHasPrompt: process.argv.some((arg) => arg.includes(${JSON.stringify(promptSentinel)})),
  },
}) + '\\n');
`);
  const prompt = `${promptSentinel}\n${'界'.repeat(75_000)}\nend`;
  // What reaches stdin is the prompt PLUS the schema block, so the byte count and digest must be
  // taken from the transmitted text. Hashing `prompt` here would have quietly asserted that the
  // schema never arrives - the exact regression this change is trying not to introduce.
  const largeSchema = {
    type: 'object',
    properties: { bytes: { type: 'integer' }, sha256: { type: 'string' }, argvHasPrompt: { type: 'boolean' } },
    required: ['bytes', 'sha256', 'argvHasPrompt'],
    additionalProperties: false,
  };
  const sent = promptWithSchema(prompt, largeSchema);
  const sentBytes = Buffer.byteLength(sent);
  const sentDigest = createHash('sha256').update(sent).digest('hex');
  const result = await runFreshClaude({
    ...baseRun(),
    prompt,
    executable: worker,
    ripgrepExecutable: worker,
    sandboxExecutable: process.execPath,
    spawn: (_sandbox, args, options) => {
      const separator = args.indexOf('--');
      assert.equal(args.includes(prompt), false);
      assert.equal(args[separator + 1], '/sandbox/claude');
      return nodeSpawn(process.execPath, [worker, ...args.slice(separator + 2)], options);
    },
    jsonSchema: largeSchema,
    validate: (value) => value.bytes === sentBytes
      && value.sha256 === sentDigest
      && value.argvHasPrompt === false,
  });
  assert.equal(result.status, 'ok', result.error);
  assert.equal(result.data.bytes, sentBytes);
  assert.equal(result.data.sha256, sentDigest);
  assert.equal(result.data.argvHasPrompt, false);
  // The 300KB prompt still dominates: the schema block is a rounding error on top of it, and the
  // whole point of the test is that neither half was truncated on the way through the pipe.
  assert.ok(sentBytes > Buffer.byteLength(prompt), 'the schema must actually be appended');
});

test('reports prompt stdin write failures as infrastructure errors', async () => {
  const result = await runFreshClaude(baseRun({
    killGraceMs: 1,
    spawn: fakeSpawn({ neverClose: true, stdinError: new Error('broken pipe') }),
  }));
  assert.equal(result.status, 'infra_error');
  assert.match(result.error, /prompt stdin: broken pipe/);
});

test('strips schema metadata unsupported by the Claude CLI validator', () => {
  const source = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'review-plan.schema.json',
    ...schema,
  };
  const cliSchema = schemaFromPrompt(promptWithSchema('plan', source));

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

test('imposes no tool fence, because the sandbox is the boundary', () => {
  const args = buildClaudeArgs({ model: 'terra', prompt: 'review', jsonSchema: schema });

  // The reviewer needs git to see what changed, and enumerating capabilities in advance is how
  // it ended up unable to. Confinement is the mount table's job - asserted in the sandbox tests
  // below - not a second list here that is weaker than bwrap and blocks real work.
  assert.equal(args.includes('--tools'), false);
  assert.equal(args.includes('--allowedTools'), false);
  assert.ok(args.includes('--dangerously-skip-permissions'));

  // --safe-mode is NOT part of that fence and must not be removed with it. It refuses CLAUDE.md,
  // skills, hooks and MCP servers, which is what stops the code under review from reconfiguring
  // the reviewer judging it. Integrity of the gate, not a limit on the reviewer.
  assert.ok(args.includes('--safe-mode'));
  assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(args[args.indexOf("--mcp-config") + 1], JSON.stringify({ mcpServers: {} }));
});

// The three tests that used to live here asserted GREP-TOOL permission behaviour: that Grep was
// refused outside /workspace and worked inside it. Granting the full toolset removes the Grep
// tool entirely - the CLI tells the model to "search file contents with `grep` via the Bash tool
// instead" - so those tests were asserting the behaviour of a tool that is no longer registered.
// Deleting them rather than porting them, because the property they protected is not gone, it
// MOVED: confinement is the mount table's now, and it is asserted directly below.
//
// MEASURED, NOT ASSUMED, and recorded here so nobody re-derives it later as a surprise: inside
// the sandbox `env` reads ANTHROPIC_API_KEY, a child process reads the environment it inherits,
// and outbound DNS resolves. That is inherent to a reviewer that runs code and must authenticate
// to a model API - no arrangement of tool permissions changes it. What DOES change it is that the
// value `env` reads is a worthless per-run nonce: when a relay base URL is configured the real key
// never enters the sandbox at all, and a host-side loopback proxy (credential-proxy.mjs) injects
// it only into requests toward the fixed relay origin. Leaking the nonce costs nothing.

test('the sandbox, not a permission list, is what confines the reviewer', () => {
  const args = buildSandboxArgs({
    executable: '/host/claude',
    ripgrepExecutable: '/host/rg',
    repositoryRoot: '/host/repo',
    environment: { ANTHROPIC_API_KEY: 'k', EVIL: 'x' },
    claudeArgs: ['-p'],
  });
  const pairIndex = (flag, value) => args.findIndex((a, i) => a === flag && args[i + 1] === value);

  // The repository is READ-ONLY. Every capability granted above is bounded by this line.
  assert.ok(pairIndex('--ro-bind', '/host/repo') >= 0);
  assert.equal(args[args.indexOf('--ro-bind', pairIndex('--ro-bind', '/host/repo')) + 2], '/workspace');
  for (const writable of ['--bind', '--bind-try', '--dev-bind', '--dev-bind-try']) {
    assert.equal(args.includes(writable), false, `${writable} may not exist: nothing may be mounted writable`);
  }

  // The host environment does not leak in: --clearenv rebuilds the sandbox env from --setenv
  // only, and the /proc environ path is masked per triple so nothing inside reads it back - not
  // even a child process, since the /dev/null binds overlay the shared mount namespace. What the
  // masks do NOT do is hide the process environment block from env/getenv; that is why the sandbox
  // holds a nonce (asserted in the runFreshClaude test below) rather than the real key.
  assert.ok(args.includes('--clearenv'));
  for (const procPath of ['/proc/self/environ', '/proc/1/environ']) {
    const index = args.indexOf(procPath);
    assert.ok(index >= 2 && args[index - 2] === '--ro-bind' && args[index - 1] === '/dev/null',
      `${procPath} must be masked by a /dev/null ro-bind triple`);
  }
  assert.equal(args.includes('EVIL'), false);

  assert.ok(args.includes('--unshare-all'));
  assert.ok(args.includes('--die-with-parent'));
});

function proxyRequest(origin, path, method = 'POST', headers = {}, body) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${origin}${path}`, {
      method,
      headers: { connection: 'close', ...headers },
    }, (response) => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: data }));
    });
    request.on('error', reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

test('credential proxy injects the real key only toward the fixed relay, never the nonce', async () => {
  const received = [];
  const upstream = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      received.push({
        path: request.url,
        method: request.method,
        key: request.headers['x-api-key'],
        auth: request.headers.authorization,
        body,
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((resolve, reject) => {
    upstream.once('error', reject);
    upstream.listen(0, '127.0.0.1', resolve);
  });
  const upstreamPort = upstream.address().port;
  const proxy = await createCredentialProxy({
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    ANTHROPIC_API_KEY: 'real-provider-key',
  });
  try {
    // The sandbox-facing credential is a worthless per-run nonce; the real key never crosses
    // the boundary, and the base URL is the loopback proxy, not the relay.
    assert.match(proxy.sandboxEnvironment.ANTHROPIC_API_KEY, /^claude-review-proxy-/);
    assert.equal(proxy.sandboxEnvironment.ANTHROPIC_API_KEY.includes('real-provider-key'), false);
    assert.match(proxy.sandboxEnvironment.ANTHROPIC_BASE_URL, /^http:\/\/127\.0\.0\.1:\d+$/);

    // A bogus sandbox-side key and any leftover auth are replaced with the real key upstream.
    const ok = await proxyRequest(proxy.origin, '/v1/messages', 'POST',
      { 'x-api-key': 'nonce-key', authorization: 'Bearer nonce' }, '{"prompt":"x"}');
    assert.equal(ok.status, 200);
    assert.deepEqual(received, [{
      path: '/v1/messages',
      method: 'POST',
      key: 'real-provider-key',
      auth: undefined,
      body: '{"prompt":"x"}',
    }]);

    // The CLI's startup probe against the bare base path is allowed through.
    const head = await proxyRequest(proxy.origin, '/', 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(received[1].method, 'HEAD');
    assert.equal(received[1].path, '/');

    // Paths outside the provider API surface are refused outright, and the upstream
    // never sees them.
    const forbidden = await proxyRequest(proxy.origin, '/v1/some-unrelated-endpoint', 'POST', {}, '{}');
    assert.equal(forbidden.status, 403);
    assert.equal(received.length, 2);

    // No key or no base URL: no proxy at all.
    assert.equal(await createCredentialProxy({ ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}` }), null);
    assert.equal(await createCredentialProxy({ ANTHROPIC_API_KEY: 'k' }), null);
    assert.equal(await createCredentialProxy({}), null);
  } finally {
    await proxy.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test('runFreshClaude keeps the real API key out of the sandbox when a relay base URL is configured', async () => {
  const realKey = 'sk-ant-real-provider-key';
  let captured;
  const result = await runFreshClaude(baseRun({
    environment: { PATH: '/bin', ANTHROPIC_API_KEY: realKey, ANTHROPIC_BASE_URL: 'https://relay.example' },
    spawn: fakeSpawn({ stdout: resultEvent({ verdict: 'PASS' }), capture: ({ args }) => { captured = args; } }),
  }));
  assert.equal(result.status, 'ok');
  const setenvValue = (name) => {
    const index = captured.findIndex((value, i) => value === '--setenv' && captured[i + 1] === name);
    return index >= 0 ? captured[index + 2] : undefined;
  };
  // The sandbox points at the loopback credential proxy and authenticates with a nonce.
  assert.match(setenvValue('ANTHROPIC_BASE_URL'), /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(setenvValue('ANTHROPIC_API_KEY'), /^claude-review-proxy-/);
  // The real key and the real relay origin never appear anywhere in the sandbox argument list.
  assert.equal(captured.includes(realKey), false);
  assert.equal(captured.includes('https://relay.example'), false);
});

test('git works against a read-only checkout it does not own', () => {
  const args = buildSandboxArgs({
    executable: '/host/claude',
    ripgrepExecutable: '/host/rg',
    repositoryRoot: '/host/repo',
    environment: {},
    claudeArgs: [],
  });
  const env = Object.fromEntries(
    args.map((a, i) => (a === '--setenv' ? [args[i + 1], args[i + 2]] : null)).filter(Boolean),
  );
  // Without these git fails in two ways that both read as "git is broken" rather than as a mount
  // decision: it takes an index lock on a read-only tree, and it refuses a directory whose owner
  // differs from the caller.
  assert.equal(env.GIT_OPTIONAL_LOCKS, '0');
  assert.equal(env.GIT_CONFIG_KEY_0, 'safe.directory');
  assert.equal(env.GIT_CONFIG_VALUE_0, '/workspace');
});


test('a thinking reply is never echoed back into a follow-up request body', async (context) => {
  // The SECOND 400 family, and the one that actually killed reviews tonight.
  // W16 counted both signatures on 2026-08-10:
  //   22x  deserialize: messages[1] unknown variant 'thinking'   <-- this test
  //    2x  Thinking mode does not support this tool_choice       <-- the test below
  // They are different defects and removing the forced tool_choice does not
  // obviously fix the first one, so it gets its own pin rather than being
  // assumed covered.
  //
  // The mechanism being asserted: with --json-schema the CLI HAD to obtain a
  // tool call, so a model that answered with thinking + text instead forced a
  // SECOND request - and that request carried the thinking block back, which
  // Console Go's deserialiser rejects. With the schema in the prompt, the text
  // IS the answer, the turn ends, and no second request is ever built.
  if (process.platform !== 'linux') return context.skip('Linux Bubblewrap test');
  const tools = nativeTestExecutables();
  if (!tools) return context.skip('CLAUDE_EXECUTABLE and RIPGREP_EXECUTABLE are required');
  const root = await mkdtemp(path.join(tmpdir(), 'claude-native-thinking-'));
  const repository = path.join(root, 'repository');
  await mkdir(repository);

  const bodies = [];
  const result = await withMockClaudeProvider((request, response) => {
    bodies.push(request);
    writeThinkingThenText(response, 'deliberating about done', '{"done":true}');
  }, (baseUrl) => runNativeClaude({
    ...tools, repository, baseUrl, secret: 'native-thinking-secret', prompt: 'Return done=true.',
  }));

  assert.equal(result.status, 'ok', result.error);
  // Self-check first: if the mock never got a request, everything below passes
  // vacuously - the exact shape of failure this file has been bitten by twice.
  assert.ok(bodies.length >= 1, 'the mock must have received at least one request');

  const echoed = bodies.flatMap((body, index) => (body.messages ?? [])
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((block) => block?.type === 'thinking')
    .map(() => `request ${index}`));
  assert.deepEqual(echoed, [],
    `a thinking block was echoed back in ${echoed.join(', ')} - Console Go rejects that body with `
    + "\"unknown variant 'thinking'\", which is 22 of tonight's 24 observed 400s");

  // The structural reason it cannot happen: the turn ends on the text reply, so
  // there is no follow-up request to carry anything. Asserted separately because
  // "no thinking echoed" would also hold if the CLI simply stripped it, and a
  // strip we do not control is not a guarantee we can rely on.
  assert.equal(bodies.length, 1,
    `expected the turn to end on the text reply; ${bodies.length} requests means a follow-up was built`);
});

test('native Claude is given the full toolset, with the sandbox as the only fence', async (context) => {
  if (process.platform !== 'linux') return context.skip('Linux Bubblewrap test');
  const tools = nativeTestExecutables();
  if (!tools) return context.skip('CLAUDE_EXECUTABLE and RIPGREP_EXECUTABLE are required');
  const root = await mkdtemp(path.join(tmpdir(), 'claude-native-tools-'));
  const repository = path.join(root, 'repository');
  await mkdir(repository);
  await writeFile(path.join(repository, 'visible.txt'), 'needle\n');
  let advertisedTools;
  let toolChoice;
  let firstPrompt;
  const result = await withMockClaudeProvider((request, response) => {
    advertisedTools ??= request.tools?.map((tool) => tool.name).sort();
    toolChoice ??= request.tool_choice ?? null;
    // The text blocks themselves, not JSON.stringify of the envelope - stringify escapes every
    // quote, so /"done"/ would never match and the assertion would only ever be testing itself.
    firstPrompt ??= (request.messages ?? [])
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .filter((block) => block?.type === 'text')
      .map((block) => block.text)
      .join('\n');
    writeText(response, '{"done":true}');
  }, (baseUrl) => runNativeClaude({
    ...tools, repository, baseUrl, secret: 'native-tool-contract-secret', prompt: 'Return done=true.',
  }));
  assert.equal(result.status, 'ok');
  // Capabilities are asserted, the LIST is not. Pinning the exact set is what made this brittle
  // in the first place: every tool the CLI adds would fail a test that has nothing to say about
  // whether the reviewer is safe, and the honest answer to "is it safe" lives in the mount table.
  // Bash and Read, not Glob and Grep. Granting the full toolset does not merely ADD Bash - the
  // CLI drops the Grep and Glob tools and tells the model to use `grep` through Bash instead, so
  // asserting them here would fail for a capability that is present by another route.
  for (const required of ['Read', 'Bash']) {
    assert.ok(advertisedTools.includes(required), `the reviewer needs ${required}`);
  }
  assert.equal(advertisedTools.includes('Grep'), false,
    'Grep and Glob are gone with the whitelist - the reviewer greps through Bash now');
  assert.equal(advertisedTools.includes('Glob'), false);

  // No StructuredOutput: --json-schema is gone (#45), so nothing forces a tool call. An
  // upstream in thinking mode answers a FORCED tool_choice with a hard 400 - deterministic,
  // routing-dependent, and invisible to every channel health check. So the wire must show no
  // forcing at all: no StructuredOutput tool to force, and no tool_choice pinning one.
  assert.equal(advertisedTools.includes('StructuredOutput'), false,
    'a StructuredOutput tool means --json-schema came back and with it the forced tool_choice');
  assert.ok(toolChoice === null || toolChoice.type === 'auto',
    `tool_choice must not force a tool, got ${JSON.stringify(toolChoice)}`);
  // And the schema still has to arrive, or "no forcing" would just mean "no contract".
  assert.match(firstPrompt, /Return ONLY a JSON value matching this JSON Schema/);
  assert.match(firstPrompt, /"required":\["done"\]/, 'the schema must reach the model in the prompt');
  // Bash specifically, because its absence is what forced the diff to be computed outside and
  // pushed in pre-sharded - the thing that made a whole review fail when one shard did.
  assert.ok(advertisedTools.length > 10, 'no curated whitelist should be back');
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
  assert.deepEqual(captured.options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(captured.options.detached, process.platform !== 'win32');
  const separator = captured.args.indexOf('--');
  assert.equal(captured.args[separator + 1], '/sandbox/claude');
  // The file is the only source of the schema here - jsonSchema is undefined. Reading it back out
  // of the prompt is what proves loadJsonSchema ran BEFORE the spawn and its result travelled;
  // the old argv assertion checked the same thing through a flag that no longer exists.
  const stdin = Buffer.concat(captured.child.stdin.writes).toString('utf8');
  assert.ok(stdin.startsWith('x'), 'the caller prompt leads, the schema block follows');
  assert.deepEqual(schemaFromPrompt(stdin), schema);
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
  const structuredRetries = await runFreshClaude(baseRun({
    spawn: fakeSpawn({
      stdout: `${JSON.stringify({
        type: 'result',
        subtype: 'error_max_structured_output_retries',
        is_error: true,
      })}\n`,
    }),
  }));
  assert.equal(structuredRetries.status, 'infra_error');
  assert.match(structuredRetries.error, /error_max_structured_output_retries/);
  assert.match(structuredRetries.diagnostic, /error_max_structured_output_retries/);

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

test('schema_error carries the validation detail and the failing output for repair retries', async () => {
  const drifted = { verdict: 'FAIL', extra_field: true };
  const rejected = await runFreshClaude(baseRun({
    timeoutMs: 10,
    killGraceMs: 1,
    spawn: fakeSpawn({ stdout: resultEvent(drifted) }),
    validate: () => false,
  }));
  assert.equal(rejected.status, 'schema_error');
  assert.equal(rejected.error, 'structured output failed schema validation');
  assert.deepEqual(rejected.rawOutput, drifted, 'the boolean-reject branch must surface the failing output');

  const thrown = await runFreshClaude(baseRun({
    timeoutMs: 10,
    killGraceMs: 1,
    spawn: fakeSpawn({ stdout: resultEvent(drifted) }),
    validate: () => { throw new TypeError('finding is missing title; got fields: extra_field, verdict'); },
  }));
  assert.equal(thrown.status, 'schema_error');
  assert.equal(thrown.error, 'schema validation failed: finding is missing title; got fields: extra_field, verdict');
  assert.deepEqual(thrown.rawOutput, drifted, 'the throwing branch must surface the failing output');
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

test('the default stdout backstop does not fire on a reasoning model\'s normal verbosity', async () => {
  // Regression pin for the outage where every open PR came back infrastructure_failure.
  // The default used to be 1_000_000, which predates the CLI emitting one
  // system/thinking_tokens event per thinking token: a measured SUCCESSFUL summary run on
  // a 12KB shard produced 365KB across 1798 lines, and larger shards cleared 1MB. Bytes
  // are the wrong dimension for "runaway" - timeoutMs owns that - so the default must sit
  // far above anything verbosity can reach. Streaming 8MB here would have tripped the old
  // default eight times over.
  const thinking = `${JSON.stringify({ type: 'system', subtype: 'thinking_tokens' })}\n`.repeat(40_000);
  assert.ok(Buffer.byteLength(thinking) > 1_000_000, 'fixture must exceed the retired 1MB default');
  const result = await runFreshClaude(baseRun({
    timeoutMs: 5_000,
    killGraceMs: 1,
    spawn: fakeSpawn({ stdout: thinking + resultEvent({ verdict: 'PASS' }) }),
  }));
  assert.equal(result.status, 'ok');
});

test('a caller can retune the stdout backstop without a new engine pin', async () => {
  const result = await runFreshClaude(baseRun({
    timeoutMs: 5_000, killGraceMs: 1, maxStdoutBytes: 8,
    spawn: fakeSpawn({ stdout: resultEvent({ verdict: 'PASS' }) }),
  }));
  assert.equal(result.status, 'infra_error');
  assert.match(result.error, /stdout limit exceeded \(8 bytes\)/);
});

test('keeps result text private by default and exposes only an opted-in bounded redacted error excerpt', async () => {
  const secret = 'provider-secret-value';
  const baseUrl = 'https://private-provider.example/tenant';
  const sensitiveResult = [
    'API Error: 400 model not found: luna',
    `key=${secret}`,
    `endpoint=${baseUrl}`,
    'Bearer bearer-secret',
    'token=token-secret',
    'PROMPT_MARKER',
    'PR_DIFF_MARKER',
  ].join(' ');
  const stdout = resultEvent(undefined, {
    is_error: true,
    api_error_status: 400,
    terminal_reason: 'api_error',
    result: sensitiveResult,
    structured_output: undefined,
  });
  const environment = {
    ANTHROPIC_API_KEY: secret,
    ANTHROPIC_BASE_URL: baseUrl,
  };

  const privateResult = await runFreshClaude(baseRun({
    environment,
    spawn: fakeSpawn({ code: 1, stdout }),
  }));
  assert.equal(privateResult.status, 'infra_error');
  assert.doesNotMatch(privateResult.diagnostic, /resultExcerpt|apiErrorStatus|terminalReason/);
  assert.equal(privateResult.diagnostic.includes('PROMPT_MARKER'), false);
  assert.equal(privateResult.diagnostic.includes('PR_DIFF_MARKER'), false);

  const canaryResult = await runFreshClaude(baseRun({
    environment,
    includeErrorResultDiagnostic: true,
    spawn: fakeSpawn({ code: 1, stdout }),
  }));
  assert.equal(canaryResult.status, 'infra_error');
  assert.match(canaryResult.diagnostic, /"apiErrorStatus":400/);
  assert.match(canaryResult.diagnostic, /"terminalReason":"api_error"/);
  assert.match(canaryResult.diagnostic, /model not found: luna/);
  assert.match(canaryResult.diagnostic, /REDACTED/);
  assert.equal(JSON.stringify(canaryResult).includes(secret), false);
  assert.equal(JSON.stringify(canaryResult).includes(baseUrl), false);
  assert.equal(JSON.stringify(canaryResult).includes('bearer-secret'), false);
  assert.equal(JSON.stringify(canaryResult).includes('token-secret'), false);
});

test('structural error status is disclosable to reviewing callers while the excerpt is not', async () => {
  const secret = 'sk-ant-structural-secret-value';
  const stdout = resultEvent(undefined, {
    is_error: true,
    api_error_status: 400,
    terminal_reason: 'api_error',
    result: 'API Error: 400 model not found: luna PROMPT_MARKER PR_DIFF_MARKER',
    structured_output: undefined,
  });
  const environment = { ANTHROPIC_API_KEY: secret };

  const statusOnly = await runFreshClaude(baseRun({
    environment,
    includeErrorResultStatus: true,
    spawn: fakeSpawn({ code: 1, stdout }),
  }));
  assert.equal(statusOnly.status, 'infra_error');
  // The whole point: a stage failure must name its upstream status instead of reporting
  // only subtype/isError, which is indistinguishable between a relay 4xx and a local fault.
  assert.match(statusOnly.diagnostic, /"apiErrorStatus":400/);
  assert.match(statusOnly.diagnostic, /"terminalReason":"api_error"/);
  // ...but reviewed content must still never appear.
  assert.doesNotMatch(statusOnly.diagnostic, /resultExcerpt/);
  assert.equal(statusOnly.diagnostic.includes('PROMPT_MARKER'), false);
  assert.equal(statusOnly.diagnostic.includes('PR_DIFF_MARKER'), false);
  assert.equal(statusOnly.diagnostic.includes('model not found'), false);
  assert.equal(JSON.stringify(statusOnly).includes(secret), false);

  // A genuinely successful run must disclose nothing extra. code: 0 with a valid
  // structured_output, and includeSuccessDiagnostic so a diagnostic actually exists to assert on -
  // otherwise the assertion would pass against `undefined` and prove nothing.
  const success = await runFreshClaude(baseRun({
    environment,
    includeErrorResultStatus: true,
    includeSuccessDiagnostic: true,
    spawn: fakeSpawn({ code: 0, stdout: resultEvent({ verdict: 'PASS' }) }),
  }));
  assert.equal(success.status, 'ok');
  assert.ok(typeof success.diagnostic === 'string' && success.diagnostic.length > 0);
  assert.doesNotMatch(success.diagnostic, /apiErrorStatus|terminalReason|resultExcerpt/);

  // Two result events must withhold the fields too - the resultEventCount === 1 gate exists
  // because a second result makes it ambiguous which one the status belongs to.
  const twoResults = await runFreshClaude(baseRun({
    environment,
    includeErrorResultStatus: true,
    spawn: fakeSpawn({
      code: 1,
      stdout: resultEvent(undefined, {
        is_error: true, api_error_status: 400, terminal_reason: 'api_error', structured_output: undefined,
      }) + resultEvent(undefined, {
        is_error: true, api_error_status: 500, terminal_reason: 'api_error', structured_output: undefined,
      }),
    }),
  }));
  assert.equal(twoResults.status, 'infra_error');
  assert.ok(typeof twoResults.diagnostic === 'string' && twoResults.diagnostic.length > 0);
  assert.doesNotMatch(twoResults.diagnostic, /apiErrorStatus|terminalReason/);
});

test('the host cpu gate message surfaces as a structured apiErrorMessage for classification', async () => {
  const stdout = resultEvent(undefined, {
    is_error: true,
    api_error_status: 503,
    terminal_reason: 'api_error',
    result: JSON.stringify({
      type: 'error',
      error: { type: 'overloaded_error', message: 'system cpu overloaded (current: 96.5%, threshold: 90%)' },
    }),
    structured_output: undefined,
  });
  const result = await runFreshClaude(baseRun({
    environment: { ANTHROPIC_API_KEY: 'cpu-gate-secret-value' },
    spawn: fakeSpawn({ code: 1, stdout }),
  }));
  assert.equal(result.status, 'infra_error');
  assert.equal(result.apiErrorStatus, 503);
  assert.equal(result.apiErrorMessage, 'system cpu overloaded (current: 96.5%, threshold: 90%)');
  assert.equal(JSON.stringify(result).includes('cpu-gate-secret-value'), false);
});

test('a non-JSON error body stays private - no apiErrorMessage for free text', async () => {
  const stdout = resultEvent(undefined, {
    is_error: true,
    api_error_status: 503,
    terminal_reason: 'api_error',
    result: 'API Error: 503 server_error PR_DIFF_MARKER',
    structured_output: undefined,
  });
  const result = await runFreshClaude(baseRun({
    environment: { ANTHROPIC_API_KEY: 'free-text-secret-value' },
    spawn: fakeSpawn({ code: 1, stdout }),
  }));
  assert.equal(result.status, 'infra_error');
  assert.equal(result.apiErrorStatus, 503);
  assert.equal(result.apiErrorMessage, undefined, 'free text must not ride as a structured field');
  assert.equal(JSON.stringify(result).includes('PR_DIFF_MARKER'), false);
  assert.equal(JSON.stringify(result).includes('free-text-secret-value'), false);
});

test('a structured body without a message field yields the status but no apiErrorMessage', async () => {
  const stdout = resultEvent(undefined, {
    is_error: true,
    api_error_status: 503,
    terminal_reason: 'api_error',
    result: JSON.stringify({ type: 'error', error: { type: 'overloaded_error' } }),
    structured_output: undefined,
  });
  const result = await runFreshClaude(baseRun({ spawn: fakeSpawn({ code: 1, stdout }) }));
  assert.equal(result.status, 'infra_error');
  assert.equal(result.apiErrorStatus, 503);
  assert.equal(result.apiErrorMessage, undefined);
});

test('a second result event withholds the envelope - the status could belong to either', async () => {
  const stdout = resultEvent(undefined, {
    is_error: true,
    api_error_status: 503,
    terminal_reason: 'api_error',
    result: JSON.stringify({
      type: 'error', error: { type: 'overloaded_error', message: 'system cpu overloaded (current: 96.5%, threshold: 90%)' },
    }),
    structured_output: undefined,
  }) + resultEvent(undefined, {
    is_error: true, api_error_status: 500, terminal_reason: 'api_error', structured_output: undefined,
  });
  const result = await runFreshClaude(baseRun({ spawn: fakeSpawn({ code: 1, stdout }) }));
  assert.equal(result.status, 'infra_error');
  assert.equal(result.apiErrorStatus, undefined);
  assert.equal(result.apiErrorMessage, undefined, 'ambiguous result events must not read the restricted field');
});

test('a CLI-level error with JSON text stays private - only terminal_reason api_error confirms a gateway envelope', async () => {
  const stdout = resultEvent(undefined, {
    is_error: true,
    api_error_status: 503,
    terminal_reason: 'error',
    result: JSON.stringify({
      type: 'error', error: { type: 'overloaded_error', message: 'system cpu overloaded (current: 96.5%, threshold: 90%)' },
    }),
    structured_output: undefined,
  });
  const result = await runFreshClaude(baseRun({
    environment: { ANTHROPIC_API_KEY: 'cli-error-secret-value' },
    spawn: fakeSpawn({ code: 1, stdout }),
  }));
  assert.equal(result.status, 'infra_error');
  assert.equal(result.apiErrorStatus, undefined);
  assert.equal(result.apiErrorMessage, undefined);
  assert.equal(JSON.stringify(result).includes('cli-error-secret-value'), false);
});

test('redacts quoted credential forms while keeping diagnostics valid JSON', async () => {
  const markers = [
    'JSON_TOKEN_LEAK_9f34c',
    'JSON_API_KEY_LEAK_9f34c',
    'PERSISTED_LITERAL_ESCAPED_TOKEN_9f34c',
    'ESCAPED_JSON_TOKEN_LEAK_9f34c',
    'DOUBLE_BEARER_LEAK_9f34c',
    'SINGLE_BEARER_LEAK_9f34c',
    'DOUBLE_TOKEN_LEAK_9f34c',
    'SINGLE_TOKEN_LEAK_9f34c',
  ];
  const result = await runFreshClaude(baseRun({
    includeErrorResultDiagnostic: true,
    spawn: fakeSpawn({
      code: 1,
      stdout: resultEvent(undefined, {
        is_error: true,
        result: [
          '{"token":"JSON_TOKEN_LEAK_9f34c","api_key":"JSON_API_KEY_LEAK_9f34c"}',
          String.raw`\{\"token\":\"PERSISTED_LITERAL_ESCAPED_TOKEN_9f34c\"\}`,
          '{"token":"prefix\\\"ESCAPED_JSON_TOKEN_LEAK_9f34c"}',
          'Authorization: Bearer "DOUBLE_BEARER_LEAK_9f34c"',
          "Authorization: Bearer 'SINGLE_BEARER_LEAK_9f34c'",
          'token="DOUBLE_TOKEN_LEAK_9f34c"',
          "token='SINGLE_TOKEN_LEAK_9f34c'",
        ].join(' '),
        structured_output: undefined,
      }),
    }),
  }));

  assert.equal(result.status, 'infra_error');
  const parsed = JSON.parse(result.diagnostic);
  assert.match(parsed.events[0].resultExcerpt, /REDACTED/);
  for (const marker of markers) {
    assert.equal(result.diagnostic.includes(marker), false, `${marker} must be redacted`);
  }
});

test('bounds opted-in error excerpts by UTF-8 bytes', async () => {
  const run = (result) => runFreshClaude(baseRun({
    includeErrorResultDiagnostic: true,
    spawn: fakeSpawn({
      code: 1,
      stdout: resultEvent(undefined, {
        is_error: true,
        result,
        structured_output: undefined,
      }),
    }),
  }));

  const exact = await run('a'.repeat(512));
  const exactDiagnostic = JSON.parse(exact.diagnostic);
  assert.equal(exactDiagnostic.events[0].resultExcerpt, 'a'.repeat(512));
  assert.equal(Buffer.byteLength(exactDiagnostic.events[0].resultExcerpt), 512);

  const over = await run('界'.repeat(171));
  const overDiagnostic = JSON.parse(over.diagnostic);
  assert.ok(Buffer.byteLength(overDiagnostic.events[0].resultExcerpt) <= 512);
  assert.match(overDiagnostic.events[0].resultExcerpt, /…$/u);
  assert.doesNotMatch(overDiagnostic.events[0].resultExcerpt, /�/u);
});

test('allows only bounded typed error metadata and exactly one result event', async () => {
  const probe = async (overrides, extraResult = '') => runFreshClaude(baseRun({
    includeErrorResultDiagnostic: true,
    spawn: fakeSpawn({
      code: 1,
      stdout: `${resultEvent(undefined, {
        is_error: true,
        result: 'bounded reason',
        structured_output: undefined,
        ...overrides,
      })}${extraResult}`,
    }),
  }));

  for (const status of [100, 599]) {
    assert.match((await probe({ api_error_status: status })).diagnostic, new RegExp(`"apiErrorStatus":${status}`));
  }
  for (const api_error_status of [99, 600, 400.5, '400']) {
    assert.doesNotMatch((await probe({ api_error_status })).diagnostic, /apiErrorStatus/);
  }
  for (const terminal_reason of ['api_error', 'a'.repeat(64)]) {
    assert.match((await probe({ terminal_reason })).diagnostic, /terminalReason/);
  }
  for (const terminal_reason of ['', 'API error', 'api-error', 'a'.repeat(65), { unsafe: true }]) {
    assert.doesNotMatch((await probe({ terminal_reason })).diagnostic, /terminalReason/);
  }
  for (const result of ['', { unsafe: true }, ['unsafe']]) {
    assert.doesNotMatch((await probe({ result })).diagnostic, /resultExcerpt/);
  }

  const success = await runFreshClaude(baseRun({
    includeErrorResultDiagnostic: true,
    includeSuccessDiagnostic: true,
    spawn: fakeSpawn({ stdout: resultEvent({ verdict: 'PASS' }, { result: 'must remain private' }) }),
  }));
  assert.equal(success.status, 'ok');
  assert.doesNotMatch(success.diagnostic, /must remain private|resultExcerpt/);

  const duplicate = await probe({}, resultEvent({ verdict: 'PASS' }));
  assert.equal(duplicate.status, 'infra_error');
  assert.doesNotMatch(duplicate.diagnostic, /bounded reason|resultExcerpt/);
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
  assert.match(malformed.diagnostic, /non_json_output/);
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

test('array-rooted schemas travel wrapped in an object envelope for the structured-output endpoint', () => {
  // The endpoint behind the relay 400s any root 'type: "array"'
  // (invalid_function_parameters), which is why the find stage could never run.
  const cliSchema = schemaFromPrompt(promptWithSchema('find', { type: 'array', items: { type: 'string' } }));
  assert.equal(cliSchema.type, 'object');
  assert.deepEqual(cliSchema.required, ['items']);
  assert.equal(cliSchema.additionalProperties, false);
  assert.deepEqual(cliSchema.properties.items, { type: 'array', items: { type: 'string' } });
  // Object-rooted schemas are untouched - no envelope, no items key.
  const plain = schemaFromPrompt(promptWithSchema('plan', schema));
  assert.deepEqual(plain, schema);
});

test('unwraps the array envelope symmetrically and still accepts a raw array reply', async () => {
  const arraySchema = { type: 'array', items: { type: 'string' } };
  for (const reply of [{ items: ['a', 'b'] }, ['a', 'b']]) {
    const result = await runFreshClaude({
      ...baseRun(),
      model: 'sol',
      jsonSchema: arraySchema,
      spawn: fakeSpawn({ stdout: resultEvent(reply) }),
      validate: (data) => Array.isArray(data),
    });
    assert.equal(result.status, 'ok', `reply shape ${JSON.stringify(reply)} must reach the validator as an array`);
    assert.deepEqual(result.data, ['a', 'b']);
  }
});

test('strips RE2-incompatible patterns for the CLI copy, keeps RE2-safe ones', () => {
  // Structured-output providers compile patterns with RE2: lookaround or a
  // backreference gets the whole schema rejected with 400 invalid_json_schema.
  const cliSchema = schemaFromPrompt(promptWithSchema('find', {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        path: { type: 'string', pattern: '^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))[^\\u0000]{1,500}$' },
        fingerprint: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        echo: { type: 'string', pattern: '^(a)\\1$' },
      },
      required: ['path', 'fingerprint', 'echo'],
      additionalProperties: false,
    },
  }));
  const properties = cliSchema.properties.items.items.properties;
  assert.equal('pattern' in properties.path, false, 'lookaround pattern must be dropped');
  assert.equal('pattern' in properties.echo, false, 'backreference pattern must be dropped');
  assert.equal(properties.fingerprint.pattern, '^[a-f0-9]{64}$', 'RE2-safe pattern must survive');
  assert.deepEqual(cliSchema.properties.items.items.required, ['path', 'fingerprint', 'echo']);
});
