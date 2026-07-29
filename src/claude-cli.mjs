import { spawn as nodeSpawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

export const READ_ONLY_TOOLS = 'Read,Glob,Grep';
export const READ_ONLY_PERMISSIONS = 'Read(//workspace/**),Glob(//workspace/**),Grep(//workspace/**)';
const SANDBOX_REPOSITORY = '/workspace';
const SANDBOX_HOME = '/home/claude';
const SANDBOX_EXECUTABLE = '/sandbox/claude';
const SANDBOX_RIPGREP = '/sandbox/rg';
const SANDBOX_PATH = '/sandbox:/usr/local/bin:/usr/bin:/bin';
const MODELS = new Set(['sol', 'terra', 'luna']);
const ALLOWED_ENV = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'LANG',
  'LC_ALL',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
]);
const EMPTY_MCP_CONFIG = '{"mcpServers":{}}';
const SECRET_ENV = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|BASE_URL)/i;
const ERROR_RESULT_DIAGNOSTIC_BYTES = 512;
const TERMINAL_REASON = /^[a-z][a-z0-9_]{0,63}$/;

export function sanitizedEnv(environment = process.env) {
  const safe = {};
  for (const [key, value] of Object.entries(environment ?? {})) {
    if (ALLOWED_ENV.has(key) && typeof value === 'string' && value.length > 0) safe[key] = value;
  }
  return safe;
}

function redactDiagnostic(value, environment) {
  let output = String(value ?? '');
  const secrets = Object.entries(environment ?? {})
    .filter(([key, secret]) => SECRET_ENV.test(key) && typeof secret === 'string' && secret.length >= 4)
    .map(([, secret]) => secret)
    .sort((left, right) => right.length - left.length);
  for (const secret of secrets) output = output.split(secret).join('[REDACTED]');
  return output
    .replace(/\bsk-ant-[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/\bBearer\s+"(?:\\.|[^"\\\r\n])*"/gi, 'Bearer "[REDACTED]"')
    .replace(/\bBearer\s+'(?:\\.|[^'\\\r\n])*'/gi, "Bearer '[REDACTED]'")
    .replace(/\bBearer\s+[^\s,"'}\]]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(api[_-]?key|token|secret|password)(["']?)\s*([:=])\s*"(?:\\.|[^"\\\r\n])*"/gi, '$1$2$3"[REDACTED]"')
    .replace(/\b(api[_-]?key|token|secret|password)(["']?)\s*([:=])\s*'(?:\\.|[^'\\\r\n])*'/gi, "$1$2$3'[REDACTED]'")
    .replace(/\b(api[_-]?key|token|secret|password)(["']?)\s*([:=])\s*[^\s,"'}\]]+/gi, '$1$2$3[REDACTED]');
}

function truncateDiagnostic(value, maxBytes = 4_000) {
  const output = String(value ?? '');
  const bytes = Buffer.from(output);
  if (bytes.length <= maxBytes) return output;
  return `${bytes.subarray(0, Math.max(0, maxBytes - 3)).toString('utf8').replace(/�$/u, '')}…`;
}

function diagnostic(value, environment, maxBytes = 4_000) {
  return truncateDiagnostic(redactDiagnostic(value, environment), maxBytes);
}

function sanitizeDiagnosticValue(value, environment) {
  if (typeof value === 'string') return redactDiagnostic(value, environment);
  if (Array.isArray(value)) return value.map((item) => sanitizeDiagnosticValue(item, environment));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .map(([key, item]) => [key, sanitizeDiagnosticValue(item, environment)]));
  }
  return value;
}

function schemaJson(jsonSchema) {
  const parsed = typeof jsonSchema === 'string' ? JSON.parse(jsonSchema) : jsonSchema;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('jsonSchema must be a JSON Schema object or JSON object string');
  }
  const { $schema: _draft, $id: _identifier, ...cliSchema } = parsed;
  return JSON.stringify(cliSchema);
}

export async function loadJsonSchema(jsonSchemaPath) {
  if (typeof jsonSchemaPath !== 'string' || jsonSchemaPath.length === 0) throw new TypeError('jsonSchemaPath must be non-empty');
  return JSON.parse(await readFile(jsonSchemaPath, 'utf8'));
}

export function buildClaudeArgs({ model, prompt, jsonSchema }) {
  if (!MODELS.has(model)) throw new TypeError('model must be sol, terra, or luna');
  if (typeof prompt !== 'string' || prompt.length === 0) throw new TypeError('prompt must be non-empty');
  return [
    '--safe-mode', '--disable-slash-commands', '--no-chrome',
    '--strict-mcp-config', '--mcp-config', EMPTY_MCP_CONFIG,
    '-p', prompt, '--no-session-persistence', '--model', model,
    '--effort', 'max', '--tools', READ_ONLY_TOOLS, '--allowedTools', READ_ONLY_PERMISSIONS,
    '--permission-mode', 'dontAsk', '--output-format', 'stream-json', '--verbose',
    '--json-schema', schemaJson(jsonSchema),
  ];
}

function nonEmptyPath(value, name) {
  if (typeof value !== 'string' || value.length === 0 || !value.startsWith('/')) {
    throw new TypeError(`${name} must be an absolute path`);
  }
  return value;
}

export function buildSandboxArgs({ executable, ripgrepExecutable, repositoryRoot, environment, claudeArgs }) {
  const hostExecutable = nonEmptyPath(executable, 'executable');
  const hostRipgrep = nonEmptyPath(ripgrepExecutable, 'ripgrepExecutable');
  const hostRepository = nonEmptyPath(repositoryRoot, 'repositoryRoot');
  const safeEnvironment = sanitizedEnv(environment);
  const args = [
    '--unshare-all', '--share-net', '--die-with-parent', '--new-session', '--as-pid-1',
    '--hostname', 'central-review',
    '--ro-bind', '/usr', '/usr',
    '--symlink', 'usr/bin', '/bin',
    '--symlink', 'usr/sbin', '/sbin',
    '--symlink', 'usr/lib', '/lib',
    '--symlink', 'usr/lib64', '/lib64',
    '--dev', '/dev',
    '--proc', '/proc',
    '--ro-bind', '/dev/null', '/proc/self/environ',
    '--ro-bind', '/dev/null', '/proc/1/environ',
    '--tmpfs', '/proc/1/task',
    '--tmpfs', '/tmp',
    '--tmpfs', '/home',
    '--dir', SANDBOX_HOME,
    '--dir', '/etc',
    '--dir', '/etc/ssl',
    '--dir', '/etc/ssl/certs',
    '--dir', '/etc/pki',
    '--dir', '/etc/pki/tls',
    '--dir', '/etc/pki/tls/certs',
    '--dir', '/etc/ca-certificates',
    '--ro-bind-try', '/etc/resolv.conf', '/etc/resolv.conf',
    '--ro-bind-try', '/etc/hosts', '/etc/hosts',
    '--ro-bind-try', '/etc/nsswitch.conf', '/etc/nsswitch.conf',
    '--ro-bind-try', '/etc/gai.conf', '/etc/gai.conf',
    '--ro-bind-try', '/etc/ssl/certs/ca-certificates.crt', '/etc/ssl/certs/ca-certificates.crt',
    '--ro-bind-try', '/etc/pki/tls/certs/ca-bundle.crt', '/etc/pki/tls/certs/ca-bundle.crt',
    '--ro-bind-try', '/etc/ca-certificates', '/etc/ca-certificates',
    '--dir', '/sandbox',
    '--ro-bind', hostExecutable, SANDBOX_EXECUTABLE,
    '--ro-bind', hostRipgrep, SANDBOX_RIPGREP,
    '--dir', SANDBOX_REPOSITORY,
    '--ro-bind', hostRepository, SANDBOX_REPOSITORY,
    '--chdir', SANDBOX_REPOSITORY,
    '--clearenv',
  ];
  const sandboxEnvironment = {
    ...safeEnvironment,
    HOME: SANDBOX_HOME,
    PATH: SANDBOX_PATH,
    USE_BUILTIN_RIPGREP: '0',
  };
  for (const [key, value] of Object.entries(sandboxEnvironment)) {
    args.push('--setenv', key, value);
  }
  return [...args, '--', SANDBOX_EXECUTABLE, ...claudeArgs];
}

function extractStructuredOutput(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new TypeError('Claude JSON envelope must be an object');
  }
  if (envelope.type !== 'result' || envelope.is_error === true || envelope.error != null
    || (typeof envelope.subtype === 'string' && envelope.subtype.startsWith('error'))) {
    const subtype = typeof envelope.subtype === 'string' && envelope.subtype.length > 0
      ? `: ${envelope.subtype}`
      : '';
    throw new TypeError(`Claude returned an error envelope${subtype}`);
  }
  if (envelope.structured_output !== undefined) return envelope.structured_output;
  if (typeof envelope.result === 'string') return JSON.parse(envelope.result);
  if (envelope.result && typeof envelope.result === 'object') return envelope.result;
  throw new TypeError('Claude envelope has no structured_output or JSON result');
}

function parseStreamJson(output) {
  const lines = String(output ?? '').split('\n').filter((line) => line.trim().length > 0);
  if (lines.length === 0) throw new TypeError('Claude stream has no JSON events');
  const events = lines.map((line) => JSON.parse(line));
  const results = events.filter((event) => event?.type === 'result');
  if (results.length !== 1) throw new TypeError('Claude stream must contain exactly one result event');
  return extractStructuredOutput(results[0]);
}

function streamDiagnostic(stdout, stderr, environment, { includeErrorResultDiagnostic = false } = {}) {
  const lines = String(stdout ?? '').split('\n').filter((line) => line.trim().length > 0);
  const resultEventCount = lines.reduce((count, line) => {
    try {
      return count + (JSON.parse(line)?.type === 'result' ? 1 : 0);
    } catch {
      return count;
    }
  }, 0);
  const events = [];
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event?.type === 'system' && event.subtype === 'init') {
        events.push({
          type: 'system',
          subtype: 'init',
          model: event.model,
          apiKeySource: event.apiKeySource,
          claudeCodeVersion: event.claude_code_version,
        });
      } else if (event?.type === 'system' && event.subtype === 'api_retry') {
        events.push({
          type: 'system',
          subtype: 'api_retry',
          attempt: event.attempt,
          maxRetries: event.max_retries,
          errorStatus: event.error_status,
          error: event.error,
        });
      } else if (event?.type === 'result') {
        const result = {
          type: 'result',
          subtype: event.subtype,
          isError: event.is_error === true,
        };
        if (includeErrorResultDiagnostic && resultEventCount === 1 && result.isError) {
          if (Number.isInteger(event.api_error_status)
            && event.api_error_status >= 100
            && event.api_error_status <= 599) {
            result.apiErrorStatus = event.api_error_status;
          }
          if (typeof event.terminal_reason === 'string' && TERMINAL_REASON.test(event.terminal_reason)) {
            result.terminalReason = event.terminal_reason;
          }
          if (typeof event.result === 'string' && event.result.length > 0) {
            result.resultExcerpt = diagnostic(event.result, environment, ERROR_RESULT_DIAGNOSTIC_BYTES);
          }
        }
        events.push(result);
      }
    } catch {
      events.push({ type: 'non_json_output' });
    }
    if (events.length >= 32) break;
  }
  const value = sanitizeDiagnosticValue({
    events,
    stderr: diagnostic(stderr, environment, 2_000),
  }, environment);
  return truncateDiagnostic(JSON.stringify(value));
}

function signalChild(child, signal) {
  if (process.platform !== 'win32' && Number.isInteger(child.pid) && child.pid > 0) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The child may not have entered its process group yet; fall back to the direct handle.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // A concurrent close means termination already converged.
  }
}

export async function runFreshClaude({
  model,
  prompt,
  jsonSchemaPath,
  jsonSchema,
  executable,
  ripgrepExecutable = process.env.RIPGREP_EXECUTABLE,
  sandboxExecutable = process.env.BWRAP_EXECUTABLE ?? 'bwrap',
  cwd,
  environment,
  timeoutMs = 120_000,
  killGraceMs = 2_000,
  maxStdoutBytes = 1_000_000,
  maxStderrBytes = 64_000,
  includeSuccessDiagnostic = false,
  includeErrorResultDiagnostic = false,
  spawn = nodeSpawn,
  validate = () => true,
}) {
  const sourceEnvironment = environment ?? process.env;
  let schema;
  try {
    schema = jsonSchema ?? await loadJsonSchema(jsonSchemaPath);
  } catch (error) {
    return { status: 'infra_error', error: diagnostic(`schema load: ${error.message}`, sourceEnvironment) };
  }

  let claudeArgs;
  let sandboxArgs;
  try {
    claudeArgs = buildClaudeArgs({ model, prompt, jsonSchema: schema });
    sandboxArgs = buildSandboxArgs({
      executable,
      ripgrepExecutable,
      repositoryRoot: cwd,
      environment: sourceEnvironment,
      claudeArgs,
    });
  } catch (error) {
    return { status: 'infra_error', error: diagnostic(`claude arguments: ${error.message}`, sourceEnvironment) };
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) return { status: 'infra_error', error: 'timeoutMs must be positive' };
  if (!Number.isInteger(killGraceMs) || killGraceMs < 0) return { status: 'infra_error', error: 'killGraceMs must be non-negative' };
  if (!Number.isInteger(maxStdoutBytes) || maxStdoutBytes < 1 || !Number.isInteger(maxStderrBytes) || maxStderrBytes < 1) {
    return { status: 'infra_error', error: 'output limits must be positive' };
  }

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(sandboxExecutable, sandboxArgs, {
        env: sanitizedEnv(sourceEnvironment),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      resolve({ status: 'infra_error', error: diagnostic(`spawn: ${error.message}`, sourceEnvironment) });
      return;
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let terminationResult;
    let graceTimer;

    const outputDiagnostic = () => streamDiagnostic(
      Buffer.concat(stdoutChunks).toString('utf8'),
      Buffer.concat(stderrChunks).toString('utf8'),
      sourceEnvironment,
      { includeErrorResultDiagnostic },
    );
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(graceTimer);
      resolve(result);
    };
    const terminate = (result) => {
      if (settled || terminationResult) return;
      terminationResult = {
        ...result,
        diagnostic: outputDiagnostic(),
      };
      clearTimeout(timeoutTimer);
      signalChild(child, 'SIGTERM');
      graceTimer = setTimeout(() => {
        signalChild(child, 'SIGKILL');
        finish(terminationResult);
      }, killGraceMs);
    };
    const append = (chunks, chunk, currentBytes, limit, stream) => {
      if (settled || terminationResult) return currentBytes;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (currentBytes + bytes.length > limit) {
        const remaining = Math.max(0, limit - currentBytes);
        if (remaining > 0) chunks.push(bytes.subarray(0, remaining));
        terminate({ status: 'infra_error', error: `${stream} limit exceeded (${limit} bytes)` });
        return limit;
      }
      chunks.push(bytes);
      return currentBytes + bytes.length;
    };

    const timeoutTimer = setTimeout(() => {
      terminate({ status: 'infra_error', error: `timeout after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => { stdoutBytes = append(stdoutChunks, chunk, stdoutBytes, maxStdoutBytes, 'stdout'); });
    child.stderr?.on('data', (chunk) => { stderrBytes = append(stderrChunks, chunk, stderrBytes, maxStderrBytes, 'stderr'); });
    child.on('error', (error) => {
      if (terminationResult) finish(terminationResult);
      else finish({ status: 'infra_error', error: diagnostic(`spawn: ${error.message}`, sourceEnvironment) });
    });
    child.on('close', (code, signal) => {
      if (terminationResult) {
        finish(terminationResult);
        return;
      }
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (code !== 0) {
        const stderrDiagnostic = diagnostic(stderr, sourceEnvironment);
        finish({
          status: 'infra_error',
          error: stderrDiagnostic ? `claude exited ${code ?? signal}: ${stderrDiagnostic}` : `claude exited ${code ?? signal}`,
          diagnostic: outputDiagnostic(),
        });
        return;
      }
      let data;
      try {
        data = parseStreamJson(stdout);
      } catch (error) {
        finish({
          status: 'infra_error',
          error: diagnostic(error.message, sourceEnvironment),
          diagnostic: outputDiagnostic(),
        });
        return;
      }
      try {
        if (!validate(data)) {
          finish({ status: 'schema_error', error: 'structured output failed schema validation' });
          return;
        }
      } catch (error) {
        finish({ status: 'schema_error', error: diagnostic(`schema validation failed: ${error.message}`, sourceEnvironment) });
        return;
      }
      finish({
        status: 'ok',
        data,
        stderr: diagnostic(stderr, sourceEnvironment),
        ...(includeSuccessDiagnostic
          ? { diagnostic: outputDiagnostic() }
          : {}),
      });
    });
  });
}
