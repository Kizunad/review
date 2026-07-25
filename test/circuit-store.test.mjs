import test from 'node:test';
import assert from 'node:assert/strict';
import {
  circuitEvent,
  createCircuitStore,
  evaluateCircuit,
  parseTrustedCircuitEvents,
  renderEventComment,
  renderSkipComment,
  STATE_MARKER,
  STATE_TITLE,
} from '../src/circuit-store.mjs';

function response(status, value) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => value === undefined ? '' : JSON.stringify(value),
  };
}

test('evaluates a three-failure sliding-window circuit and expires it deterministically', () => {
  const events = [0, 10, 20].map((minute, index) => circuitEvent({
    runId: index + 1,
    runAttempt: 1,
    phase: 'review',
    at: new Date(Date.UTC(2026, 6, 25, 0, minute)).toISOString(),
  }));
  const open = evaluateCircuit(events, '2026-07-25T00:30:00.000Z');
  assert.equal(open.open, true);
  assert.equal(open.openUntil, '2026-07-25T01:20:00.000Z');
  assert.equal(evaluateCircuit(events, '2026-07-25T01:20:00.000Z').open, false);
});

test('trusts only canonical GitHub bot markers and deduplicates run attempts', () => {
  const event = circuitEvent({ runId: 9, runAttempt: 2, phase: 'provider', at: '2026-07-25T00:00:00.000Z' });
  const body = renderEventComment(event, 4);
  const comments = [
    { user: { login: 'attacker', type: 'User' }, body },
    { user: { login: 'github-actions[bot]', type: 'Bot' }, body },
    { user: { login: 'github-actions[bot]', type: 'Bot' }, body },
  ];
  assert.deepEqual(parseTrustedCircuitEvents(comments), [event]);
  assert.equal(evaluateCircuit([event, event], '2026-07-25T00:10:00.000Z', { threshold: 2 }).open, false);
  assert.match(renderSkipComment({ open: true, openUntil: '2026-07-25T01:20:00.000Z' }), /\/review/);
});

test('loads, creates, records, and deduplicates circuit state through GitHub JSON endpoints', async () => {
  const calls = [];
  let issueCreated = false;
  let storedComment = null;
  const event = circuitEvent({ runId: 55, runAttempt: 1, phase: 'review' });
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/issues') && init?.method === 'POST') {
      issueCreated = true;
      return response(201, { number: 7 });
    }
    if (parsed.pathname.endsWith('/issues') && !init?.method) {
      return response(200, issueCreated ? [{
        number: 7,
        title: STATE_TITLE,
        body: STATE_MARKER,
        user: { login: 'github-actions[bot]', type: 'Bot' },
      }] : []);
    }
    if (parsed.pathname.endsWith('/issues/7/comments') && init?.method === 'POST') {
      storedComment = JSON.parse(init.body).body;
      return response(201, { id: 1 });
    }
    if (parsed.pathname.endsWith('/issues/7/comments')) {
      return response(200, storedComment ? [{ user: { login: 'github-actions[bot]', type: 'Bot' }, body: storedComment }] : []);
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const store = createCircuitStore({
    apiUrl: 'https://api.github.example',
    repository: 'org/repo',
    token: 'secret',
    fetchImpl,
  });
  assert.equal(await store.record(event, 4), true);
  assert.equal(await store.record(event, 4), false);
  assert.deepEqual(await store.loadEvents(), [event]);
  assert.ok(calls.every((call) => call.init.headers.Authorization === 'Bearer secret'));
});
