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
  // The failure log and the skip notice belong to the repository being REVIEWED, which is not
  // always $GITHUB_REPOSITORY. In v1 the two are the same thing by construction - the caller
  // runs the reusable workflow inside its own repository. v2 is also dispatched on the engine
  // repository against another repository's pull request, and there PR_NUMBER means nothing
  // locally: reading state would look at the wrong issue list, and recording would post an
  // infrastructure-failure comment onto whatever Kizunad/review issue happens to carry that
  // number. Overriding the ambient GITHUB_REPOSITORY for one step was the alternative, and it
  // relies on the runner letting a GITHUB_* default be shadowed - behaviour the docs reserve
  // and which I could not verify here. An explicit opt-in variable needs no such assumption,
  // and leaves every existing v1 call site byte-identical.
  const repository = environment.CIRCUIT_REPOSITORY || environment.GITHUB_REPOSITORY;
  const store = createCircuitStore({
    apiUrl: environment.GITHUB_API_URL,
    repository,
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
    const trustedDispatchRetry = environment.REVIEW_TRIGGER === 'workflow_dispatch'
      && environment.CIRCUIT_MANUAL_RETRY === 'true';
    if (trustedDispatchRetry) {
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
    // THE COMMENT IS THE COURTESY. THE SKIP IS THE PRODUCT.
    //
    // Observed on run 31400071113: this threw an unhandled 403 "Resource not accessible by
    // integration" and killed the step. The breaker had decided correctly - it was open until
    // 14:50:26Z and it saved a fifty-minute run - and the only thing that went wrong was that a
    // dispatch trial in Kizunad/review cannot comment on a pull request in Kizunad/Bong, because
    // github.token is scoped to the repository the run lives in. Under the shipped workflow_call
    // the token is the caller's and this succeeds.
    //
    // Crashing here converted a correct decision into a red step, and it is the SECOND place a
    // cross-repo comment failure has been fatal in this workflow. So the failure is caught - but
    // NOT swallowed: it prints the comment body it could not post, so the decision is still
    // legible in the log, and it names the token scope so the next person is not sent looking
    // for a breaker bug that does not exist. Silence is the failure mode this whole job exists
    // to prevent; a loud log is not silence, an unhandled throw with no comment is.
    const body = renderSkipComment({ open: true, openUntil: environment.CIRCUIT_OPEN_UNTIL });
    try {
      await store.postPullRequestComment(environment.PR_NUMBER, body);
    } catch (error) {
      console.error(`circuit: could not post the skip notice to PR ${environment.PR_NUMBER}: ${error.message}`);
      console.error('circuit: the skip decision below STANDS - only the comment failed.');
      console.error('circuit: a 403 here means github.token cannot write to the reviewed repo,');
      console.error('circuit: which is expected for a cross-repo dispatch trial and not for workflow_call.');
      console.error(body);
    }
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
