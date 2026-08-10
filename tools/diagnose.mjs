#!/usr/bin/env node
// diagnose.mjs — classify a harvested review run from its artifact fields,
// not from the collapsed "after N attempts: claude exited 1" string.
//
// Usage: node tools/diagnose.mjs <artifact-dir> [<artifact-dir> ...]
//
// Each dir may be a harvest dir (evidence/<pr>-<runid>/) or the nested
// central-review-<runid>-1/ artifact dir; review.json is located inside.
// Prints, per run: the decision, one line per stage failure and coverage gap
// with terminal reason / HTTP status / model / attempts / retryable when the
// artifact carries them, and an explicit final status that never lets
// "unclassifiable" read as "clean".

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const TERMINAL_REASON = /^[a-z][a-z0-9_]{0,63}$/;
const isHttpStatus = (value) => Number.isInteger(value) && value >= 100 && value <= 599;

export function parseDiagnostic(raw) {
  if (raw === undefined || raw === null || raw === '') return { kind: 'absent' };
  if (typeof raw !== 'string') return { kind: 'nonjson' };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'nonjson' };
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.events)) {
    return { kind: 'noevents', stderr: typeof parsed?.stderr === 'string' ? parsed.stderr : '' };
  }
  if (parsed.events.length === 0) return { kind: 'noevents', stderr: typeof parsed.stderr === 'string' ? parsed.stderr : '' };
  return { kind: 'events', events: parsed.events, stderr: typeof parsed.stderr === 'string' ? parsed.stderr : '' };
}

export function classifyEvents(events) {
  const init = events.find((event) => event?.type === 'system' && event?.subtype === 'init');
  const retries = events
    .filter((event) => event?.type === 'system' && event?.subtype === 'api_retry')
    .map((event) => event.errorStatus)
    .filter(isHttpStatus);
  const results = events.filter((event) => event?.type === 'result');
  // Same disclosure gate as the engine's own extractApiError: one result
  // event, marked error, api_error terminal reason, integer status in range.
  // Anything else is not trusted enough to name an api failure.
  const confirmed = results.length === 1
    && results[0]?.isError === true
    && results[0]?.terminalReason === 'api_error'
    && isHttpStatus(results[0]?.apiErrorStatus)
    ? results[0]
    : null;
  const distinctRetryStatuses = [...new Set(retries)].sort((left, right) => left - right);
  return {
    model: typeof init?.model === 'string' && init.model.length > 0 ? init.model : undefined,
    terminalReason: confirmed ? 'api_error' : undefined,
    apiErrorStatus: confirmed ? confirmed.apiErrorStatus : undefined,
    retryStatuses: distinctRetryStatuses,
    retryCount: retries.length,
    unconfirmedResults: results.length > 0 && !confirmed ? results.length : 0,
  };
}

export function classifyFailure(failure = {}) {
  const diag = parseDiagnostic(failure.diagnostic);
  const events = diag.kind === 'events'
    ? classifyEvents(diag.events)
    : { model: undefined, terminalReason: undefined, apiErrorStatus: undefined, retryStatuses: [], retryCount: 0, unconfirmedResults: 0 };
  const structured = {
    apiErrorStatus: isHttpStatus(failure.apiErrorStatus) ? failure.apiErrorStatus : undefined,
    apiErrorMessage: typeof failure.apiErrorMessage === 'string' && failure.apiErrorMessage.length > 0
      ? failure.apiErrorMessage
      : undefined,
    terminalReason: typeof failure.terminalReason === 'string' && TERMINAL_REASON.test(failure.terminalReason)
      ? failure.terminalReason
      : undefined,
    model: typeof failure.model === 'string' && failure.model.length > 0 ? failure.model : undefined,
    attempts: Number.isSafeInteger(failure.attempts) && failure.attempts >= 0 ? failure.attempts : undefined,
    retryable: typeof failure.retryable === 'boolean' ? failure.retryable : undefined,
  };

  const terminalReason = structured.terminalReason ?? events.terminalReason;
  const apiErrorStatus = structured.apiErrorStatus ?? events.apiErrorStatus;
  const model = structured.model ?? events.model;
  // retryable is derivable for schema_error by contract (deterministic) but
  // never assumed for infra_error without the structured field.
  const retryable = structured.retryable
    ?? (failure.status === 'schema_error' ? false : undefined);
  const attempts = structured.attempts;

  const evidence = [];
  if (events.retryStatuses.length > 0) {
    evidence.push(`cli retried ${events.retryCount}x ${events.retryStatuses.join('/')}`);
  }
  if (events.unconfirmedResults > 0) {
    evidence.push(`${events.unconfirmedResults} unconfirmed result event(s) not trusted`);
  }
  if (diag.kind === 'nonjson') evidence.push('diagnostic is not JSON');
  if (diag.kind === 'noevents') evidence.push('diagnostic has no events');
  if (diag.kind === 'absent') evidence.push('no diagnostic recorded');
  if (diag.kind === 'events' && events.model === undefined && events.terminalReason === undefined
    && events.apiErrorStatus === undefined && events.retryStatuses.length === 0) {
    evidence.push('diagnostic events carry no classification evidence');
  }
  if (diag.kind === 'noevents' && diag.stderr) {
    evidence.push(`stderr: ${diag.stderr.slice(0, 80)}`);
  }

  const classified = terminalReason !== undefined
    || apiErrorStatus !== undefined
    || model !== undefined
    || retryable !== undefined
    || failure.status === 'schema_error';
  return {
    stage: failure.stage ?? 'unknown-stage',
    status: failure.status ?? 'unknown',
    terminalReason,
    apiErrorStatus,
    apiErrorMessage: structured.apiErrorMessage,
    model,
    attempts,
    retryable,
    cliRetryStatuses: events.retryStatuses,
    cliRetryCount: events.retryCount,
    evidence,
    classified,
  };
}

export function classifyCoverageGap(gap = {}) {
  const failure = { ...gap, diagnostic: gap.diagnostic };
  const classified = classifyFailure(failure);
  return {
    stage: gap.stage ?? 'unknown-stage',
    batch: Number.isInteger(gap.batch) ? gap.batch : undefined,
    paths: Array.isArray(gap.paths) ? gap.paths : [],
    error: gap.error ?? '',
    ...classified,
  };
}

export function classifyReview(review = {}) {
  const failures = Array.isArray(review.failures) ? review.failures.map(classifyFailure) : [];
  const coverageGaps = Array.isArray(review.coverageGaps) ? review.coverageGaps.map(classifyCoverageGap) : [];
  const decision = review.decision ?? 'unknown';
  const unclassifiedFailures = failures.filter((failure) => !failure.classified);
  const unclassifiedGaps = coverageGaps.filter((gap) => !gap.classified);

  let status;
  let clean = false;
  if (decision === 'infrastructure_failure' && failures.length === 0) {
    status = 'MALFORMED — infrastructure_failure with no failure records';
  } else if (failures.length === 0 && coverageGaps.length === 0) {
    clean = true;
    status = 'CLEAN — no failures, no coverage gaps';
  } else if (failures.length === 0) {
    status = `DECIDED — ${coverageGaps.length} coverage gap(s), ${unclassifiedGaps.length} unclassified`;
  } else if (unclassifiedFailures.length === 0 && unclassifiedGaps.length === 0) {
    status = `FAILED — ${failures.length} failure(s), all classified`;
  } else {
    status = `FAILED — ${failures.length} failure(s): ${failures.length - unclassifiedFailures.length} classified, `
      + `${unclassifiedFailures.length} unclassified; ${unclassifiedGaps.length} unclassified gap(s)`;
  }
  return { decision, failures, coverageGaps, unclassifiedFailures, unclassifiedGaps, status, clean };
}

function factLines(classified) {
  const lines = [];
  const facts = [];
  if (classified.terminalReason !== undefined) facts.push(`terminal ${classified.terminalReason}`);
  if (classified.apiErrorStatus !== undefined) facts.push(`status ${classified.apiErrorStatus}`);
  if (classified.model !== undefined) facts.push(`model ${classified.model}`);
  if (classified.attempts !== undefined) facts.push(`attempts ${classified.attempts}`);
  if (classified.retryable !== undefined) facts.push(`retryable ${classified.retryable ? 'yes' : 'no'}`);
  if (classified.cliRetryCount > 0) facts.push(`cli retries ${classified.cliRetryCount}x${classified.cliRetryStatuses.join('/')}`);
  if (facts.length > 0) lines.push(`      ${facts.join('  ')}`);
  if (classified.apiErrorMessage !== undefined) lines.push(`      api message: ${classified.apiErrorMessage}`);
  if (classified.evidence.length > 0) lines.push(`      ${classified.evidence.join('; ')}`);
  return lines;
}

export function formatReport(review, context = {}) {
  const classified = classifyReview(review);
  const header = [];
  if (context.pullNumber !== undefined) header.push(`PR ${context.pullNumber}`);
  if (context.runId !== undefined) header.push(`run ${context.runId}`);
  if (header.length === 0) header.push('run');
  const lines = [`${header.join(' ')} — decision ${classified.decision}`];
  for (const failure of classified.failures) {
    lines.push(`  failure  ${failure.stage}  ${failure.status}${failure.classified ? '' : '  UNCLASSIFIED'}`);
    lines.push(...factLines(failure));
  }
  for (const gap of classified.coverageGaps) {
    lines.push(`  gap      ${gap.stage}${gap.batch !== undefined ? ` batch ${gap.batch}` : ''}${gap.classified ? '' : '  UNCLASSIFIED'}`);
    lines.push(...factLines(gap));
  }
  lines.push(`  status:  ${classified.status}`);
  if (!classified.clean && classified.unclassifiedFailures.length + classified.unclassifiedGaps.length > 0) {
    lines.push('           missing diagnostic fields are not evidence of a healthy stage —'
      + ' unclassified is not clean');
  }
  return lines.join('\n');
}

export async function loadReview(dir) {
  const candidates = [
    join(dir, 'review.json'),
    join(dir, 'manifest.json'),
  ];
  const top = await Promise.all(candidates.map(async (file) => {
    try {
      await readFile(file);
      return file;
    } catch {
      return null;
    }
  }));
  let reviewFile = top[0];
  let manifestFile = top[1];
  if (!reviewFile) {
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      throw new Error(`cannot read artifact directory: ${dir}`);
    }
    const subdirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    const found = [];
    for (const subdir of subdirs) {
      try {
        await readFile(join(dir, subdir, 'review.json'));
        found.push(join(dir, subdir, 'review.json'));
      } catch {
        // not this subdir
      }
      if (!manifestFile) {
        try {
          await readFile(join(dir, subdir, 'manifest.json'));
          manifestFile = join(dir, subdir, 'manifest.json');
        } catch {
          // no manifest here
        }
      }
    }
    if (found.length === 1) reviewFile = found[0];
    else if (found.length > 1) throw new Error(`multiple review.json files under ${dir}: ${found.join(', ')}`);
  }
  if (!reviewFile) throw new Error(`no review.json found under ${dir}`);
  const review = JSON.parse(await readFile(reviewFile, 'utf8'));
  let context = {};
  if (manifestFile) {
    try {
      const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
      context = {
        pullNumber: manifest.pullNumber,
        runId: manifest.runId,
      };
    } catch {
      context = {};
    }
  }
  return { review, context, reviewFile };
}

async function main(argv) {
  if (argv.length === 0) {
    console.error('usage: node tools/diagnose.mjs <artifact-dir> [<artifact-dir> ...]');
    process.exitCode = 1;
    return;
  }
  const reports = [];
  for (const dir of argv) {
    try {
      const { review, context } = await loadReview(dir);
      reports.push(formatReport(review, context));
    } catch (error) {
      reports.push(`${dir} — ERROR: ${error.message}`);
      process.exitCode = 1;
    }
  }
  console.log(reports.join('\n\n'));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main(process.argv.slice(2));
}
