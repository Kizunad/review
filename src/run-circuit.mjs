#!/usr/bin/env node
import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
  circuitEvent,
  createCircuitStore,
  evaluateCircuit,
  renderSkipComment,
} from './circuit-store.mjs';

function requireEnvironment(environment, names) {
  for (const key of names) {
    if (typeof environment[key] !== 'string' || environment[key].length === 0) {
      throw new Error(`${key} is required`);
    }
  }
}

function positiveInteger(environment, name, fallback) {
  const value = environment[name] === undefined ? fallback : Number(environment[name]);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

export async function runCircuit(command, {
  environment = process.env,
  fetchImpl = fetch,
  append = appendFile,
  now = () => new Date().toISOString(),
} = {}) {
  requireEnvironment(environment, ['GITHUB_API_URL', 'GITHUB_REPOSITORY', 'GITHUB_TOKEN', 'PR_NUMBER']);
  const store = createCircuitStore({
    apiUrl: environment.GITHUB_API_URL,
    repository: environment.GITHUB_REPOSITORY,
    token: environment.GITHUB_TOKEN,
    fetchImpl,
  });
  const config = {
    threshold: positiveInteger(environment, 'CIRCUIT_THRESHOLD', 3),
    windowMs: positiveInteger(environment, 'CIRCUIT_WINDOW_MINUTES', 60) * 60_000,
    durationMs: positiveInteger(environment, 'CIRCUIT_DURATION_MINUTES', 60) * 60_000,
  };

  if (command === 'preflight') {
    requireEnvironment(environment, ['GITHUB_OUTPUT']);
    const manualBypass = environment.REVIEW_TRIGGER === 'issue_comment' && environment.REVIEW_COMMENT_BODY === '/review';
    if (manualBypass) {
      await append(environment.GITHUB_OUTPUT, 'should_run=true\n');
      return;
    }
    try {
      const state = evaluateCircuit(await store.loadEvents(), now(), config);
      if (state.open) {
        await append(environment.GITHUB_OUTPUT, `should_run=false\nopen_until=${state.openUntil}\n`);
      } else {
        await append(environment.GITHUB_OUTPUT, 'should_run=true\n');
      }
    } catch {
      console.error('circuit preflight failed open; continuing review');
      await append(environment.GITHUB_OUTPUT, 'should_run=true\n');
    }
    return;
  }

  if (command === 'skip-comment') {
    requireEnvironment(environment, ['CIRCUIT_OPEN_UNTIL']);
    await store.postPullRequestComment(environment.PR_NUMBER, renderSkipComment({
      open: true,
      openUntil: environment.CIRCUIT_OPEN_UNTIL,
    }));
    return;
  }

  if (command === 'record') {
    requireEnvironment(environment, ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT']);
    const event = circuitEvent({
      runId: environment.GITHUB_RUN_ID,
      runAttempt: environment.GITHUB_RUN_ATTEMPT,
      phase: environment.FAILURE_PHASE || 'review',
      at: now(),
    });
    try {
      await store.record(event, environment.PR_NUMBER);
      const events = await store.loadEvents();
      const identity = `${event.run_id}:${event.run_attempt}`;
      const combined = events.some((value) => `${value.run_id}:${value.run_attempt}` === identity)
        ? events
        : [...events, event];
      const state = evaluateCircuit(combined, event.at, config);
      if (state.open) console.error(`central review circuit open until ${state.openUntil}`);
    } catch {
      console.error('circuit record failed; the review result remains authoritative');
    }
    return;
  }

  throw new Error(`unknown circuit command: ${command}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCircuit(process.argv[2]);
}
