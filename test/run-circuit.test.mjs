import test from 'node:test';
import assert from 'node:assert/strict';
import { circuitEvent, renderEventComment, STATE_MARKER, STATE_TITLE } from '../src/circuit-store.mjs';
import { runCircuit } from '../src/run-circuit.mjs';

function response(status, value) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => value === undefined ? '' : JSON.stringify(value),
  };
}

const bot = { login: 'github-actions[bot]', type: 'Bot' };

function environment(overrides = {}) {
  return {
    GITHUB_API_URL: 'https://api.github.example',
    GITHUB_REPOSITORY: 'org/repo',
    GITHUB_TOKEN: 'secret',
    GITHUB_RUN_ID: '88',
    GITHUB_RUN_ATTEMPT: '2',
    PR_NUMBER: '4',
    GITHUB_OUTPUT: '/tmp/output',
    ...overrides,
  };
}

function readOnlyStateFetch(events, { fail = false } = {}) {
  return async (url, init) => {
    if (fail) return response(503, { message: 'unavailable' });
    assert.equal(init?.method, undefined);
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/issues')) {
      return response(200, [{ number: 7, title: STATE_TITLE, body: STATE_MARKER, user: bot }]);
    }
    if (parsed.pathname.endsWith('/issues/7/comments')) {
      return response(200, events.map((event) => ({ user: bot, body: renderEventComment(event, 4) })));
    }
    throw new Error(`unexpected URL ${url}`);
  };
}

const failureEvents = [0, 10, 20].map((minute, index) => circuitEvent({
  runId: index + 1,
  runAttempt: 1,
  phase: 'review',
  at: new Date(Date.UTC(2026, 6, 25, 0, minute)).toISOString(),
}));

test('preflight reads circuit state without writing and emits an open-circuit skip', async () => {
  const outputs = [];
  await runCircuit('preflight', {
    environment: environment(),
    fetchImpl: readOnlyStateFetch(failureEvents),
    append: async (_path, value) => outputs.push(value),
    now: () => '2026-07-25T00:30:00.000Z',
  });
  assert.deepEqual(outputs, ['should_run=false\nopen_until=2026-07-25T01:20:00.000Z\n']);
});

test('exact manual review bypasses the circuit without reading or writing GitHub state', async () => {
  const outputs = [];
  await runCircuit('preflight', {
    environment: environment({ REVIEW_TRIGGER: 'issue_comment', REVIEW_COMMENT_BODY: '/review' }),
    fetchImpl: async () => { throw new Error('GitHub state must not be accessed'); },
    append: async (_path, value) => outputs.push(value),
  });
  assert.deepEqual(outputs, ['should_run=true\n']);
});

test('explicit trusted workflow dispatch retry bypasses the circuit without reading or writing state', async () => {
  const outputs = [];
  let fetched = false;
  await runCircuit('preflight', {
    environment: environment({ REVIEW_TRIGGER: 'workflow_dispatch', CIRCUIT_MANUAL_RETRY: 'true' }),
    fetchImpl: async () => {
      fetched = true;
      return response(200, []);
    },
    append: async (_path, value) => outputs.push(value),
  });
  assert.deepEqual(outputs, ['should_run=true\n']);
  assert.equal(fetched, false);
});

test('workflow dispatch without explicit retry opt-in remains protected by the open circuit', async () => {
  const outputs = [];
  await runCircuit('preflight', {
    environment: environment({ REVIEW_TRIGGER: 'workflow_dispatch', CIRCUIT_MANUAL_RETRY: 'false' }),
    fetchImpl: readOnlyStateFetch(failureEvents),
    append: async (_path, value) => outputs.push(value),
    now: () => '2026-07-25T00:30:00.000Z',
  });
  assert.deepEqual(outputs, ['should_run=false\nopen_until=2026-07-25T01:20:00.000Z\n']);
});

test('retry opt-in cannot bypass the circuit for a different trigger or command', async () => {
  for (const overrides of [
    { REVIEW_TRIGGER: 'issue_comment', REVIEW_COMMENT_BODY: '/review-next', CIRCUIT_MANUAL_RETRY: 'true' },
    { REVIEW_TRIGGER: 'pull_request_target', CIRCUIT_MANUAL_RETRY: 'true' },
  ]) {
    const outputs = [];
    await runCircuit('preflight', {
      environment: environment(overrides),
      fetchImpl: readOnlyStateFetch(failureEvents),
      append: async (_path, value) => outputs.push(value),
      now: () => '2026-07-25T00:30:00.000Z',
    });
    assert.deepEqual(outputs, ['should_run=false\nopen_until=2026-07-25T01:20:00.000Z\n']);
  }
});

test('preflight fails open when trusted circuit state cannot be read', async () => {
  const outputs = [];
  await runCircuit('preflight', {
    environment: environment(),
    fetchImpl: readOnlyStateFetch([], { fail: true }),
    append: async (_path, value) => outputs.push(value),
  });
  assert.deepEqual(outputs, ['should_run=true\n']);
});

test('record does not double-count an event returned by the post-write reload', async () => {
  let stored = null;
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/issues') && !init?.method) {
      return response(200, [{ number: 7, title: STATE_TITLE, body: STATE_MARKER, user: bot }]);
    }
    if (parsed.pathname.endsWith('/issues/7/comments') && init?.method === 'POST') {
      stored = JSON.parse(init.body).body;
      return response(201, { id: 1 });
    }
    if (parsed.pathname.endsWith('/issues/7/comments')) {
      return response(200, stored ? [{ user: bot, body: stored }] : []);
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const errors = [];
  const originalError = console.error;
  console.error = (message) => errors.push(message);
  try {
    await runCircuit('record', {
      environment: environment({ CIRCUIT_THRESHOLD: '2' }),
      fetchImpl,
      now: () => '2026-07-25T00:30:00.000Z',
    });
  } finally {
    console.error = originalError;
  }
  assert.ok(stored);
  assert.deepEqual(errors, []);
});
